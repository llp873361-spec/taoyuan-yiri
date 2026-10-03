// 共用地面着色（规格书阶段 12 CP3）：远景和各地点自己的地形都用它给地面加真贴图的细节，接缝两边是同一套贴图、同一套世界坐标。
//
// 四层：草甸、林地、岩石、沙土（Poly Haven CC0，scripts/opt.mjs 处理成 1024 的 WebP），拼成两张贴图数组：颜色、法线。
// 绘本化：颜色还是各场景自己按调色板算的反照率，贴图只给明暗（亮度 / 这一层的平均亮度）、一点点色相和法线细节，
// 不让照片的颜色把画面弄脏。
// 平地：世界 xz 投影 + 六角平铺（hex tiling，做法参照 Mikkelsen 2022《Practical Real-Time Hex-Tiling》，自己重写）：
//   把平面切成三角网格，每个格点给贴图一个随机平移和旋转，三个格点按重心坐标的高次幂混合，重复的花纹被打散；
//   法线贴图跟着把切线面里的 xy 转回去。最强的那一层采三次，第二强的一层只采一次（只在交界处用得上）。
// 陡坡：按"等高线方向 × 高度"投影（贴着坡面展开），不像俯视投影那样被竖着拉成条（原来崖面"拉花"就是这个）。
// 只在近处（near 米以内）采样；导数在分支外先算好，分支里用显式梯度采样（WGSL 不许在非一致分支里隐式求导）。

import * as THREE from 'three/webgpu';
import {
	If, float, vec2, vec3, vec4, uniform, uniformArray, texture, dFdx, dFdy,
	floor, fract, dot, max, mix, smoothstep, normalize, sin, cos, step, pow, length, select, cross,
} from 'three/tsl';
import { loadTextureArray } from '../core/assets.js';
import { hash22 } from './noise.js';

// 层的顺序（贴图数组的层号）
export const groundLayerNames = [ '草甸', '林地', '岩石', '沙土' ];

// 线性空间的平均亮度（Rec.709 系数）：每 13 个像素取一个，sRGB → 线性
function meanLuminance( data, layerBytes, layer ) {

	const toLinear = ( value ) => {

		const c = value / 255;
		return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );

	};

	let sum = 0;
	let count = 0;
	for ( let i = layer * layerBytes; i < ( layer + 1 ) * layerBytes; i += 4 * 13 ) {

		sum += 0.2126 * toLinear( data[ i ] ) + 0.7152 * toLinear( data[ i + 1 ] ) + 0.0722 * toLinear( data[ i + 2 ] );
		count ++;

	}

	return sum / Math.max( 1, count );

}

// 读贴图、建数组。settings：config.ground；缺任何一张都返回 null（中文警告），调用方用原来的程序化地面
export async function loadGroundTextures( settings, anisotropy = 4 ) {

	const ids = settings.layers.map( ( layer ) => layer.texture );
	const size = settings.textureSize;
	const diffuse = await loadTextureArray( 'textures', ids.map( ( id ) => id + '-diff' ), size, { colorSpace: THREE.SRGBColorSpace, anisotropy } );
	const normal = diffuse ? await loadTextureArray( 'textures', ids.map( ( id ) => id + '-nor' ), size, { colorSpace: THREE.NoColorSpace, anisotropy } ) : null;
	if ( ! diffuse || ! normal ) {

		if ( diffuse ) diffuse.dispose();
		console.warn( '地面：地表贴图没读全，地面用原来的程序化细节' );
		return null;

	}

	diffuse.name = '地表贴图·颜色';
	normal.name = '地表贴图·法线';
	const layerBytes = size * size * 4;
	// 每层：x = 一张贴图铺多少米，y = 线性平均亮度（明暗按它归一），z = 法线强度，w = 留着
	const layerInfo = uniformArray( settings.layers.map( ( layer, index ) => new THREE.Vector4( layer.meters, meanLuminance( diffuse.image.data, layerBytes, index ), layer.normalStrength, 0 ) ), 'vec4' );
	const toggles = {
		地表贴图: uniform( 1 ),
		六角平铺: uniform( 1 ),
		三向投影: uniform( 1 ),
	};
	console.log( `地面：地表贴图 ${ settings.layers.length } 层（${ size }²），平均亮度 ${ layerInfo.array.map( ( item ) => item.y.toFixed( 3 ) ).join( ' / ' ) }` );
	return {
		diffuse,
		normal,
		layerInfo,
		toggles,
		settings,
		dispose() {

			diffuse.dispose();
			normal.dispose();

		},
	};

}

// 三角网格（六角平铺用）：返回三个格点和重心坐标权重
function triangleGrid( uv ) {

	const scaled = uv.mul( 2 * Math.sqrt( 3 ) );
	const skewed = vec2( scaled.x, scaled.x.mul( - 0.57735027 ).add( scaled.y.mul( 1.15470054 ) ) );
	const base = floor( skewed );
	const local = fract( skewed );
	const third = float( 1 ).sub( local.x ).sub( local.y );
	const upper = step( 0, third.negate() );          // 1 = 在格子的上半个三角形
	const sign = upper.mul( 2 ).sub( 1 );
	const weights = vec3( third.negate().mul( sign ), upper.sub( local.y.mul( sign ) ), upper.sub( local.x.mul( sign ) ) );
	return {
		weights,
		vertices: [ base.add( vec2( upper, upper ) ), base.add( vec2( upper, float( 1 ).sub( upper ) ) ), base.add( vec2( float( 1 ).sub( upper ), upper ) ) ],
	};

}

// 二维旋转
const rotate2 = ( vector, cosine, sine ) => vec2( vector.x.mul( cosine ).sub( vector.y.mul( sine ) ), vector.x.mul( sine ).add( vector.y.mul( cosine ) ) );

// 地面细节。ground：loadGroundTextures 的结果；
//   point：世界坐标；normal：世界法线（已经是这个场景自己算好的地面法线）；weights：vec4（草甸、林地、岩石、沙土，和不必为 1）；
//   viewDistance：离镜头多远（米）；near：多远以内采样（uniform 或数）；
// 返回 { shade（乘到反照率上的 vec3）, normal（扰动后的世界法线）}。远处 shade = 1、法线不变
export function groundDetail( ground, { point, normal, weights, viewDistance, near } ) {

	const info = ground.layerInfo;
	const toggles = ground.toggles;
	const settings = ground.settings;
	const shade = vec3( 1 ).toVar();
	const detailNormal = normal.toVar();

	// ---------- 分支外：坐标、导数、权重 ----------
	// 平地的贴图坐标按世界 xz（米）；陡坡按等高线方向和高度。导数按"米"求，进分支后再除以每层的尺寸
	const flatMeters = vec2( point.x, point.z.negate() ).toVar();
	const horizontal = vec2( normal.x, normal.z );
	const contour = normalize( vec2( horizontal.y.negate(), horizontal.x ).add( vec2( 1e-4, 0 ) ) ).toVar();
	const steepMeters = vec2( dot( point.xz, contour ), point.y ).toVar();
	const flatDx = dFdx( flatMeters ).toVar();
	const flatDy = dFdy( flatMeters ).toVar();
	const steepDx = dFdx( steepMeters ).toVar();
	const steepDy = dFdy( steepMeters ).toVar();
	const slope = float( 1 ).sub( normal.y );
	const steepAmount = smoothstep( 0.3, 0.55, slope ).mul( toggles.三向投影 ).toVar();

	// 平地上最强、第二强的两层（岩石在平地上也可能有：碎石滩）
	const w = weights;
	const firstIsMeadow = w.x.greaterThanEqual( max( max( w.y, w.z ), w.w ) );
	const firstIsForest = w.y.greaterThanEqual( max( w.z, w.w ) );
	const firstIsRock = w.z.greaterThanEqual( w.w );
	const firstLayer = select( firstIsMeadow, float( 0 ), select( firstIsForest, float( 1 ), select( firstIsRock, float( 2 ), float( 3 ) ) ) ).toVar();
	const firstWeight = max( max( w.x, w.y ), max( w.z, w.w ) );
	// 把最强的那一层去掉以后再取最大
	const rest = vec4(
		select( firstLayer.equal( 0 ), float( - 1 ), w.x ),
		select( firstLayer.equal( 1 ), float( - 1 ), w.y ),
		select( firstLayer.equal( 2 ), float( - 1 ), w.z ),
		select( firstLayer.equal( 3 ), float( - 1 ), w.w ),
	);
	const secondIsMeadow = rest.x.greaterThanEqual( max( max( rest.y, rest.z ), rest.w ) );
	const secondIsForest = rest.y.greaterThanEqual( max( rest.z, rest.w ) );
	const secondIsRock = rest.z.greaterThanEqual( rest.w );
	const secondLayer = select( secondIsMeadow, float( 0 ), select( secondIsForest, float( 1 ), select( secondIsRock, float( 2 ), float( 3 ) ) ) ).toVar();
	const secondWeight = max( max( rest.x, rest.y ), max( rest.z, rest.w ) );
	const secondShare = secondWeight.div( max( firstWeight.add( secondWeight ), 1e-4 ) ).toVar();
	const rockWeight = w.z.div( max( w.x.add( w.y ).add( w.z ).add( w.w ), 1e-4 ) ).toVar();

	const fade = float( 1 ).sub( smoothstep( float( near ).mul( 0.7 ), float( near ), viewDistance ) ).mul( toggles.地表贴图 ).toVar();

	If( fade.greaterThan( 0.001 ), () => {

		// 一次采样：layer 层，坐标 meters（米），导数 dx、dy（米），转 angle（cos、sin）；返回颜色和法线（切线面）
		const sampleLayer = ( layer, meters, dx, dy, cosine, sine, offset ) => {

			const layerData = info.element( layer.toInt() );
			const scale = float( 1 ).div( layerData.x );
			const uv = rotate2( meters.mul( scale ), cosine, sine ).add( offset );
			const gradX = rotate2( dx.mul( scale ), cosine, sine );
			const gradY = rotate2( dy.mul( scale ), cosine, sine );
			const color = texture( ground.diffuse, uv ).depth( layer.toInt() ).grad( gradX, gradY ).rgb;
			const tangent = texture( ground.normal, uv ).depth( layer.toInt() ).grad( gradX, gradY ).xy.mul( 2 ).sub( 1 );
			// 法线贴图在转过的坐标里，转回来
			const tangentBack = rotate2( tangent, cosine, sine.negate() ).mul( layerData.z );
			return { color, tangent: tangentBack, mean: layerData.y };

		};

		// ---------- 平地：最强层三次（六角平铺），第二层一次 ----------
		const grid = triangleGrid( flatMeters.div( info.element( firstLayer.toInt() ).x ) );
		const hexOn = ground.toggles.六角平铺;
		const sharpened = pow( grid.weights, vec3( settings.hexContrast ) );
		const hexWeights = mix( vec3( 1, 0, 0 ), sharpened.div( sharpened.x.add( sharpened.y ).add( sharpened.z ) ), hexOn ).toVar();
		const flatColor = vec3( 0 ).toVar();
		const flatTangent = vec2( 0 ).toVar();
		const flatWeight = float( 0 ).toVar();
		grid.vertices.forEach( ( vertex, index ) => {

			// 份量太小的格点不采（锐化 4 次方以后约一半像素只剩一个格点有份量，关掉六角平铺时只剩第一个），
			// 采到的按份量和重新归一，丢掉的不到 1%（核显上省一到两次颜色 + 法线的梯度采样）
			const weight = [ hexWeights.x, hexWeights.y, hexWeights.z ][ index ];
			If( weight.greaterThan( 0.004 ), () => {

				const random = hash22( vertex );
				const angle = random.x.mul( Math.PI * 2 ).mul( hexOn );
				const offset = random.mul( 7.13 ).mul( hexOn );
				const sample = sampleLayer( firstLayer, flatMeters, flatDx, flatDy, cos( angle ), sin( angle ), offset );
				flatColor.addAssign( sample.color.mul( weight ) );
				flatTangent.addAssign( sample.tangent.mul( weight ) );
				flatWeight.addAssign( weight );

			} );

		} );

		const firstMean = info.element( firstLayer.toInt() ).y;
		const firstShade = flatColor.div( max( flatWeight, 1e-4 ) ).div( max( firstMean, 1e-3 ) );
		const firstTangent = flatTangent.div( max( flatWeight, 1e-4 ) );
		// 第二层只在份额够大时采（单一地类的大片地方份额是 0，原来照样采一次）
		const usedShare = select( secondShare.greaterThan( 0.004 ), secondShare, float( 0 ) ).toVar();
		const secondShade = vec3( 1 ).toVar();
		const secondTangent = vec2( 0 ).toVar();
		If( usedShare.greaterThan( 0 ), () => {

			const second = sampleLayer( secondLayer, flatMeters, flatDx, flatDy, float( 1 ), float( 0 ), vec2( 0.37, 0.71 ) );
			secondShade.assign( second.color.div( max( second.mean, 1e-3 ) ) );
			secondTangent.assign( second.tangent );

		} );
		// 每层先按自己的平均亮度归一（暗的岩石、亮的沙子都变成"平均 1"的明暗），再按两层的份额混
		const flatShade = mix( firstShade, secondShade, usedShare ).toVar();
		const flatNormalXY = mix( firstTangent, secondTangent, usedShare );

		// ---------- 陡坡：岩石层按等高线投影 ----------
		// 坡度不到 0.3 时 steepAmount 正好是 0，平地上整段不采
		const useSteep = steepAmount.mul( max( rockWeight, 0.35 ) ).toVar();
		const steepShade = vec3( 1 ).toVar();
		const steepTangent = vec2( 0 ).toVar();
		If( useSteep.greaterThan( 0 ), () => {

			const steep = sampleLayer( float( 2 ), steepMeters, steepDx, steepDy, float( 1 ), float( 0 ), vec2( 0.13, 0.29 ) );
			steepShade.assign( steep.color.div( max( steep.mean, 1e-3 ) ) );
			steepTangent.assign( steep.tangent );

		} );
		const textureShade = mix( flatShade, steepShade, useSteep );
		const tangentXY = mix( flatNormalXY, steepTangent, useSteep ).mul( fade );

		// 明暗：亮度比的 contrast 次方（绘本里的笔触明暗，比照片平一点）；色相只留 colorAmount 那么一点
		const luminanceRatio = dot( textureShade, vec3( 0.2126, 0.7152, 0.0722 ) );
		const brightness = pow( max( luminanceRatio, 0.02 ), settings.contrast );
		const hue = textureShade.div( max( luminanceRatio, 0.02 ) );
		shade.assign( mix( vec3( 1 ), mix( vec3( brightness ), hue.mul( brightness ), settings.colorAmount ), fade ) );

		// 法线：平地的切线 x 朝世界 +x、y 朝世界 −z；陡坡的切线 x 朝等高线方向、y 朝上。都先投到地面的切平面上
		const flatTangentX = normalize( vec3( 1, 0, 0 ).sub( normal.mul( normal.x ) ) );
		const flatTangentY = normalize( cross( normal, flatTangentX ) );
		const steepTangentX = normalize( vec3( contour.x, 0, contour.y ).sub( normal.mul( dot( normal, vec3( contour.x, 0, contour.y ) ) ) ) );
		const steepTangentY = normalize( cross( normal, steepTangentX ) );
		const tangentX = normalize( mix( flatTangentX, steepTangentX, useSteep ) );
		const tangentY = normalize( mix( flatTangentY, steepTangentY, useSteep ) );
		detailNormal.assign( normalize( normal.add( tangentX.mul( tangentXY.x ) ).add( tangentY.mul( tangentXY.y ) ) ) );

	} );

	return { shade, normal: detailNormal };

}

// 调试面板的开关（地表贴图、六角平铺、三向投影）
export function groundLayers( ground ) {

	return ground ? { ...ground.toggles } : {};

}

// 给地点用的：这个场景的 point（场景坐标）换到世界坐标再算细节；sceneToWorld 是远景的那个 uniform
export function groundDetailInScene( ground, sceneToWorld, { point, normal, weights, near, cameraPoint } ) {

	const worldPoint = sceneToWorld.mul( vec4( point, 1 ) ).xyz;
	const worldNormal = normalize( sceneToWorld.mul( vec4( normal, 0 ) ).xyz );
	const viewDistance = length( point.sub( cameraPoint ) );
	const result = groundDetail( ground, { point: worldPoint, normal: worldNormal, weights, viewDistance, near } );
	// 法线换回场景坐标（sceneToWorld 是刚体变换：转置的旋转部分就是逆）
	const sceneNormal = normalize( vec4( result.normal, 0 ).mul( sceneToWorld ).xyz );
	return { shade: result.shade, normal: sceneNormal };

}

