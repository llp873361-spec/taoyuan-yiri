// 场景 5：凌晨极光雪原。规格书第 7 节。
// 人自由漫游（WASD 走、拖动转头），从脚印起点出发，沿脚印走向远处的黑石和枯树。
//
// 组成：
//   地形：CPU 生成高度场（大起伏 + 枕头一样鼓的雪丘 + 路径两侧压平 + 岩石脚下的堆雪），同时存成半精度纹理给着色器用
//   雪材质：MeshPhysicalNodeMaterial 的子类，逐层叠加 ①~⑧（见 createSnowMaterial），每层一个 uniform 开关
//   脚印：启动时生成 32 种脚印的图集，着色器按"第几步、左右脚"挑一个；20 米内视差遮蔽，20 米外只改法线
//   极光：分层采样画到一张"方向参数化"的半球贴图里（转头不拖影），指数滑动平均去条纹；再降采样成平均色照亮雪地
//   天空：渐变 + 星星 + 月亮 + 极光贴图；远山剪影；贴地高度雾
//   粒子：飘雪（两层，全 GPU）、地吹雪卷流带 + 少量贴地亮粒
//   岩石、枯树：程序化

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, uniform, float, int, vec2, vec3, vec4, color, texture, uv,
	positionWorld, positionView, positionLocal, normalWorld, normalViewGeometry, normalWorldGeometry, cameraPosition, cameraViewMatrix,
	instanceIndex, faceDirection, BRDF_Lambert, diffuseContribution, normalView,
	mix, smoothstep, clamp, max, min, abs, pow, exp, sqrt, sin, cos, atan, asin, floor, fract, length, normalize, dot, cross,
	dFdx, dFdy, fwidth, log2, step, luminance,
} from 'three/tsl';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash21, hash33, valueNoise2D, fbm2D, voronoi2D, curlNoise3D, domainWarp2D, jsFbm2D, jsValueNoise2D, jsHash21 } from '../tsl/noise.js';
import { sparkleLayer } from '../tsl/sparkle.js';
import { heightFog, henyeyGreenstein } from '../tsl/fog.js';
import { starField, moonGlow } from '../tsl/sky.js';

export const key = 'aurora';

// ===================== 路径（脚印走的线）=====================
// 用解析曲线代替样条：x 随 z 平滑弯曲，JS 和着色器算出来完全一样；人从 z=0 往 -z 走。
// 两组不同频率的正弦叠加，400 米里弯三四次，最大斜率约 0.25，脚印间距的误差小于 3%。

const pathPhase = 1.1;
const pathOffset = 4 * Math.sin( pathPhase );

function pathX( z ) {

	return 9 * Math.sin( z * 0.013 ) + 4 * Math.sin( z * 0.033 + pathPhase ) - pathOffset;

}

function pathSlope( z ) {

	return 9 * 0.013 * Math.cos( z * 0.013 ) + 4 * 0.033 * Math.cos( z * 0.033 + pathPhase );

}

const pathXNode = ( z ) => sin( z.mul( 0.013 ) ).mul( 9 ).add( sin( z.mul( 0.033 ).add( pathPhase ) ).mul( 4 ) ).sub( pathOffset );
const pathSlopeNode = ( z ) => cos( z.mul( 0.013 ) ).mul( 9 * 0.013 ).add( cos( z.mul( 0.033 ).add( pathPhase ) ).mul( 4 * 0.033 ) );

// 脚印参数（米）：步距 0.8、左右脚中心离路径中线 0.17（左右间距 0.34）
const stepLength = 0.8;
const footSideOffset = 0.17;
const footprintDepthMax = 0.07;       // 最深的凹陷
const footprintRimHeight = 0.012;     // 边缘堆起来的雪
const footTileWidth = 0.32;           // 图集里一格对应的世界尺寸（含边缘）
const footTileLength = 0.64;
const atlasColumns = 8;
const atlasRows = 4;
const atlasTileWidth = 64;
const atlasTileHeight = 128;

// 岩石和枯树都在路径尽头
const pathEndZ = - 400;
const treeZ = pathEndZ - 5;

// ===================== 模块状态 =====================

const state = {
	ctx: null,
	scene: null,
	ready: false,
	disposables: [],      // 需要 dispose 的几何体、材质、贴图、渲染目标
	heightData: null,     // Float32Array，高度场
	heightResolution: 0,
	terrainSize: 0,
	terrainCenterZ: 0,
	uniforms: null,
	layers: null,
	moonLight: null,
	hemisphereLight: null,
	skyDome: null,
	bands: [],
	snowNear: null,
	snowFar: null,
	driftSparks: null,
	auroraPass: null,
	heightTexture: null,
	auroraColors: null,   // 预先解析好的颜色，每帧不再 new
	auroraAverageColor: new THREE.Color(),
	readbackPending: false,
	frameIndex: 0,
	revealDistance: 0,
	currentTier: '',
	rockSpots: [],
	treePosition: new THREE.Vector3(),
};

// ===================== 地形高度场（CPU）=====================

function terrainHeightRaw( x, z, rocks ) {

	// 大尺度起伏：波长约 120 米，高差 8~12 米
	const large = ( jsFbm2D( x / 120 + 3.1, z / 120 - 7.4, 3 ) - 0.5 ) * 2 * 14;

	// 中尺度雪丘：沿风向略拉长，波长 15~30 米；先 smoothstep 再 1-(1-t)² 做成"枕头"——顶部鼓圆、谷底收窄，没有尖棱
	const windAngle = state.ctx.config.aurora.windDirection * Math.PI / 180;
	const along = x * Math.cos( windAngle ) + z * Math.sin( windAngle );
	const across = - x * Math.sin( windAngle ) + z * Math.cos( windAngle );
	const duneNoise = jsFbm2D( along / 30, across / 18, 3 );
	const duneT = Math.min( 1, Math.max( 0, ( duneNoise - 0.3 ) / 0.45 ) );
	const duneSmooth = duneT * duneT * ( 3 - 2 * duneT );
	const pillow = 1 - ( 1 - duneSmooth ) * ( 1 - duneSmooth );
	let dunes = pillow * 1.6;

	// 沿脚印路径两侧 8 米压平一些，让路好走
	const clampedZ = Math.min( 0, Math.max( pathEndZ, z ) );
	const alongPathGap = z - clampedZ;
	const pathDistance = Math.hypot( x - pathX( clampedZ ), alongPathGap );
	const flatten = 1 - Math.min( 1, Math.max( 0, ( pathDistance - 2 ) / 6 ) );
	dunes *= 1 - 0.75 * flatten;

	let height = large + dunes;

	// 地形最外 80 米平滑落到海拔 0，和外面那圈平的雪接上，走到哪都看不到断崖
	const halfSize = state.terrainSize / 2;
	const borderDistance = Math.min( halfSize - Math.abs( x ), halfSize - Math.abs( z - state.terrainCenterZ ) );
	const borderT = Math.min( 1, Math.max( 0, borderDistance / 80 ) );
	height *= borderT * borderT * ( 3 - 2 * borderT );

	// 岩石脚下一圈堆雪（被雪半埋的感觉）
	for ( const rock of rocks ) {

		const distance = Math.hypot( x - rock.x, z - rock.z );
		const ratio = distance / ( rock.size * 1.7 );
		height += rock.size * 0.35 * Math.exp( - ratio * ratio );

	}

	return height;

}

// 生成高度场 + 曲率（拉普拉斯），存成 RG 半精度纹理
function buildHeightField( resolution, size, centerZ, rocks ) {

	const heights = new Float32Array( resolution * resolution );
	const cellSize = size / ( resolution - 1 );

	for ( let j = 0; j < resolution; j ++ ) {

		const z = centerZ - size / 2 + j * cellSize;
		for ( let i = 0; i < resolution; i ++ ) {

			const x = - size / 2 + i * cellSize;
			heights[ j * resolution + i ] = terrainHeightRaw( x, z, rocks );

		}

	}

	// 拉普拉斯（凸起处为负）。隔一格取样，量的是雪丘尺度的弯曲而不是单格噪声
	const halfData = new Uint16Array( resolution * resolution * 2 );
	const reach = 2;
	for ( let j = 0; j < resolution; j ++ ) {

		for ( let i = 0; i < resolution; i ++ ) {

			const index = j * resolution + i;
			const left = heights[ j * resolution + Math.max( 0, i - reach ) ];
			const right = heights[ j * resolution + Math.min( resolution - 1, i + reach ) ];
			const down = heights[ Math.max( 0, j - reach ) * resolution + i ];
			const up = heights[ Math.min( resolution - 1, j + reach ) * resolution + i ];
			const laplacian = ( left + right + down + up - 4 * heights[ index ] ) / ( ( reach * cellSize ) * ( reach * cellSize ) );
			halfData[ index * 2 ] = THREE.DataUtils.toHalfFloat( heights[ index ] );
			halfData[ index * 2 + 1 ] = THREE.DataUtils.toHalfFloat( laplacian );

		}

	}

	const heightTexture = new THREE.DataTexture( halfData, resolution, resolution, THREE.RGFormat, THREE.HalfFloatType );
	heightTexture.magFilter = THREE.LinearFilter;
	heightTexture.minFilter = THREE.LinearFilter;
	heightTexture.wrapS = THREE.ClampToEdgeWrapping;
	heightTexture.wrapT = THREE.ClampToEdgeWrapping;
	heightTexture.generateMipmaps = false;
	heightTexture.needsUpdate = true;

	return { heights, heightTexture };

}

// JS 版地面高度（双线性），相机贴地、摆岩石用
function heightAt( x, z ) {

	if ( ! state.heightData ) return NaN;
	const resolution = state.heightResolution;
	const size = state.terrainSize;
	const gridX = ( x + size / 2 ) / size * ( resolution - 1 );
	const gridZ = ( z - ( state.terrainCenterZ - size / 2 ) ) / size * ( resolution - 1 );
	const i = Math.min( resolution - 2, Math.max( 0, Math.floor( gridX ) ) );
	const j = Math.min( resolution - 2, Math.max( 0, Math.floor( gridZ ) ) );
	const fractionX = Math.min( 1, Math.max( 0, gridX - i ) );
	const fractionZ = Math.min( 1, Math.max( 0, gridZ - j ) );
	const data = state.heightData;
	const corner00 = data[ j * resolution + i ];
	const corner10 = data[ j * resolution + i + 1 ];
	const corner01 = data[ ( j + 1 ) * resolution + i ];
	const corner11 = data[ ( j + 1 ) * resolution + i + 1 ];
	const near = corner00 * ( 1 - fractionX ) + corner10 * fractionX;
	const far = corner01 * ( 1 - fractionX ) + corner11 * fractionX;
	return near * ( 1 - fractionZ ) + far * fractionZ;

}

function buildTerrainGeometry( segments, size, centerZ ) {

	const geometry = new THREE.PlaneGeometry( size, size, segments, segments );
	geometry.rotateX( - Math.PI / 2 );
	geometry.translate( 0, 0, centerZ );
	const positions = geometry.attributes.position;
	for ( let i = 0; i < positions.count; i ++ ) {

		positions.setY( i, heightAt( positions.getX( i ), positions.getZ( i ) ) );

	}

	geometry.computeVertexNormals();
	return geometry;

}

// ===================== 脚印图集（CPU，启动时生成）=====================
// 每格一只脚印：前掌椭圆 + 后跟椭圆的平滑并集，边缘用噪声弄碎；R = 凹陷深度，G = 边缘外侧堆起来的雪

// 平滑并集（二次多项式 smooth min）：两个距离接近时往下"圆"一点，两个椭圆接成一只脚
function smoothMin( distanceA, distanceB, blendWidth ) {

	const blend = Math.max( blendWidth - Math.abs( distanceA - distanceB ), 0 ) / blendWidth;
	return Math.min( distanceA, distanceB ) - blend * blend * blendWidth * 0.25;

}

function ellipseDistance( x, y, centerY, radiusX, radiusY ) {

	// 近似椭圆有符号距离：归一化后的距离乘较小半径
	const normalizedX = x / radiusX;
	const normalizedY = ( y - centerY ) / radiusY;
	return ( Math.sqrt( normalizedX * normalizedX + normalizedY * normalizedY ) - 1 ) * Math.min( radiusX, radiusY );

}

function buildFootprintAtlas() {

	const width = atlasColumns * atlasTileWidth;
	const height = atlasRows * atlasTileHeight;
	const data = new Uint8Array( width * height * 4 );

	for ( let tile = 0; tile < atlasColumns * atlasRows; tile ++ ) {

		const column = tile % atlasColumns;
		const row = Math.floor( tile / atlasColumns );
		const seed = tile * 37.17;
		// 每只脚印的长宽、前后掌比例都随机一点
		const footLength = 0.36 + jsHash21( tile, 1 ) * 0.05;
		const footWidth = 0.2 + jsHash21( tile, 2 ) * 0.035;
		const toeY = footLength * 0.18;
		const heelY = - footLength * 0.27;
		const tilt = ( jsHash21( tile, 3 ) - 0.5 ) * 0.25;   // 前后深浅不同

		for ( let y = 0; y < atlasTileHeight; y ++ ) {

			for ( let x = 0; x < atlasTileWidth; x ++ ) {

				// 格内坐标（米），原点在格中心，+y 朝脚尖
				const localX = ( ( x + 0.5 ) / atlasTileWidth - 0.5 ) * footTileWidth;
				const localY = ( ( y + 0.5 ) / atlasTileHeight - 0.5 ) * footTileLength;

				const toe = ellipseDistance( localX, localY, toeY, footWidth * 0.5, footLength * 0.34 );
				const heel = ellipseDistance( localX, localY, heelY, footWidth * 0.42, footLength * 0.25 );
				let distance = smoothMin( toe, heel, 0.05 );

				// 碎边：大一点的起伏 + 细碎颗粒，让边缘像雪塌下去
				const angle = Math.atan2( localY, localX );
				distance += ( jsValueNoise2D( angle * 3 + seed, seed * 0.3 ) - 0.5 ) * 0.022;
				distance += ( jsValueNoise2D( localX * 160 + seed, localY * 160 ) - 0.5 ) * 0.01;

				// 凹陷：边缘 2.5 厘米内陡降，里面基本平，带一点前后倾斜和压痕纹理
				let depth = 0;
				if ( distance < 0 ) {

					const wall = Math.min( 1, - distance / 0.025 );
					const wallSmooth = wall * wall * ( 3 - 2 * wall );
					const slope = 1 + tilt * ( localY / footLength );
					const sole = 1 - ( jsValueNoise2D( localX * 70 + seed, localY * 30 ) - 0.5 ) * 0.15;
					depth = wallSmooth * slope * sole;

				}

				// 边缘外侧一圈微微隆起，外加几颗被踢出来的雪粒
				let rim = 0;
				if ( distance > - 0.005 ) {

					const ring = ( distance - 0.012 ) / 0.011;
					rim = Math.exp( - ring * ring ) * ( 0.55 + 0.45 * jsValueNoise2D( angle * 5 + seed, 3.3 ) );
					const crumb = jsValueNoise2D( localX * 90 + seed * 2, localY * 90 );
					if ( distance > 0.01 && distance < 0.06 && crumb > 0.78 ) rim += ( crumb - 0.78 ) * 3;

				}

				// 格子边上留 0：mipmap 和双线性采样不会串到隔壁
				if ( x === 0 || y === 0 || x === atlasTileWidth - 1 || y === atlasTileHeight - 1 ) {

					depth = 0;
					rim = 0;

				}

				const pixel = ( ( row * atlasTileHeight + y ) * width + column * atlasTileWidth + x ) * 4;
				data[ pixel ] = Math.round( Math.min( 1, Math.max( 0, depth ) ) * 255 );
				data[ pixel + 1 ] = Math.round( Math.min( 1, Math.max( 0, rim ) ) * 255 );
				data[ pixel + 2 ] = 0;
				data[ pixel + 3 ] = 255;

			}

		}

	}

	const atlas = new THREE.DataTexture( data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType );
	atlas.magFilter = THREE.LinearFilter;
	atlas.minFilter = THREE.LinearMipmapLinearFilter;
	atlas.generateMipmaps = true;
	atlas.colorSpace = THREE.NoColorSpace;
	atlas.needsUpdate = true;
	return atlas;

}

// ===================== 着色器里的小工具 =====================

// 世界 XZ → 高度纹理 UV
function terrainUV( xz ) {

	const size = state.terrainSize;
	const resolution = state.heightResolution;
	// CPU 格点 i 在纹理里是第 i 个纹素的中心 (i + 0.5) / res，不对齐会差半格（约 0.7 米）
	const scale = ( resolution - 1 ) / resolution / size;
	const offset = 0.5 / resolution;
	return vec2(
		xz.x.add( size / 2 ).mul( scale ).add( offset ),
		xz.y.sub( state.terrainCenterZ - size / 2 ).mul( scale ).add( offset ),
	);

}

// 把方向（世界空间，单位向量）映射到极光半球贴图的 UV：u = 方位角，v = sqrt(仰角/90°)，地平线附近分辨率更高
function hemisphereUV( direction ) {

	const azimuth = atan( direction.x, direction.z.negate() );
	const mapU = fract( azimuth.div( Math.PI * 2 ) );
	const elevation = asin( clamp( direction.y, 0, 1 ) );
	const mapV = sqrt( elevation.div( Math.PI / 2 ) );
	return vec2( mapU, mapV );

}

// 半球贴图 UV → 方向
function hemisphereDirection( mapUV ) {

	const elevation = mapUV.y.mul( mapUV.y ).mul( Math.PI / 2 );
	const azimuth = mapUV.x.mul( Math.PI * 2 );
	return vec3( cos( elevation ).mul( sin( azimuth ) ), sin( elevation ), cos( elevation ).mul( cos( azimuth ) ).negate() );

}

// 屏幕导数 bump（Mikkelsen 2010《Bump Mapping Unparametrized Surfaces on the GPU》）：
// 不需要切线，直接用高度的屏幕导数扰动法线；全部在视图空间算
function bumpNormal( surfacePosition, surfaceNormal, height ) {

	const sigmaX = dFdx( surfacePosition );
	const sigmaY = dFdy( surfacePosition );
	const crossY = cross( sigmaY, surfaceNormal );
	const crossX = cross( surfaceNormal, sigmaX );
	const determinant = dot( sigmaX, crossY ).mul( faceDirection );
	const gradient = determinant.sign().mul( crossY.mul( dFdx( height ) ).add( crossX.mul( dFdy( height ) ) ) );
	return normalize( abs( determinant ).mul( surfaceNormal ).sub( gradient ) );

}

// ===================== 脚印（着色器）=====================
// 给世界 XZ 算这一点落在哪只脚印里：返回 vec3( 深度 0~1（已乘本脚印深浅）, 边缘堆雪 0~1, 是否在脚印范围 )
// lod：图集的 mip 级别（显式给，循环和分支里不能用隐式导数）

function footprintSample( xz, lod ) {

	const { atlasNode, revealDistance, revealEnabled } = state.uniforms;

	const along = xz.y.negate();
	const stepIndex = floor( along.div( stepLength ).add( 0.5 ) );
	const stepZ = stepIndex.mul( stepLength ).negate();
	const slope = pathSlopeNode( stepZ );
	const forward = normalize( vec2( slope.negate(), - 1 ) );
	const right = normalize( vec2( 1, slope.negate() ) );

	// 偶数步左脚，奇数步右脚
	const side = fract( stepIndex.mul( 0.5 ) ).greaterThan( 0.25 ).select( float( 1 ), float( - 1 ) );
	const random = hash33( vec3( stepIndex, 7, 3 ) );
	const randomB = hash33( vec3( stepIndex, 11, 5 ) );

	const center = vec2( pathXNode( stepZ ), stepZ )
		.add( right.mul( side.mul( footSideOffset ).add( random.x.sub( 0.5 ).mul( 0.05 ) ) ) )
		.add( forward.mul( random.y.sub( 0.5 ).mul( 0.08 ) ) );
	const delta = xz.sub( center );
	// 右脚镜像，这样图集里只需画左脚
	const localAcross = dot( delta, right ).mul( side.negate() );
	const localAlong = dot( delta, forward );

	// 脚尖外八 6° + 随机 ±5°，再随机缩放 ±5%
	const angle = float( 0.105 ).add( random.z.sub( 0.5 ).mul( 0.17 ) );
	const rotatedAcross = localAcross.mul( cos( angle ) ).sub( localAlong.mul( sin( angle ) ) );
	const rotatedAlong = localAcross.mul( sin( angle ) ).add( localAlong.mul( cos( angle ) ) );
	const scale = mix( 0.95, 1.05, randomB.x );
	const tileU = rotatedAcross.div( scale ).div( footTileWidth ).add( 0.5 );
	const tileV = rotatedAlong.div( scale ).div( footTileLength ).add( 0.5 );
	const inside = step( 0, tileU ).mul( step( tileU, 1 ) ).mul( step( 0, tileV ) ).mul( step( tileV, 1 ) );

	const tileIndex = floor( randomB.y.mul( atlasColumns * atlasRows ) );
	const tileColumn = tileIndex.mod( atlasColumns );
	const tileRow = floor( tileIndex.div( atlasColumns ) );
	const atlasUV = vec2(
		tileColumn.add( clamp( tileU, 0, 1 ) ).div( atlasColumns ),
		tileRow.add( clamp( tileV, 0, 1 ) ).div( atlasRows ),
	);
	const sampled = atlasNode.sample( atlasUV ).level( lod );

	// 揭示动画：只有前方 revealDistance 以内的脚印出现，最后 0.8 米渐显
	const revealFade = revealEnabled.greaterThan( 0.5 ).select( float( 1 ).sub( smoothstep( revealDistance.sub( 0.8 ), revealDistance, along ) ), float( 1 ) );
	// 起点前没有脚印
	const started = step( 1, stepIndex );
	const strength = inside.mul( revealFade ).mul( started );
	// 每只脚印深浅不同
	const depthScale = mix( 0.75, 1.15, randomB.z );

	return vec3( sampled.r.mul( depthScale ).mul( strength ), sampled.g.mul( strength ), strength );

}

// ===================== 雪材质 =====================

function createSnowMaterial( tierName ) {

	const auroraConfig = state.ctx.config.aurora;
	const uniforms = state.uniforms;
	const sparkleLevels = tierName === 'lo' ? 1 : 2;

	// 光照模型：在原版 PhysicalLightingModel 的直接光上，补一份"包裹光照 - 兰伯特"的差值，并在明暗交界线混入蓝色。
	// 只改漫反射，镜面和绒光仍走原版（super.direct），不复制原版代码
	class SnowLightingModel extends THREE.PhysicalLightingModel {

		direct( lightData, builder ) {

			super.direct( lightData, builder );

			const { lightDirection, lightColor, reflectedLight } = lightData;
			const dotNL = normalView.dot( lightDirection );
			const wrap = uniforms.wrapAmount.mul( uniforms.wrapToggle );
			// ② 包裹光照 diff = saturate((N·L + w) / (1 + w))：背光面不会突然变黑，雪显得软
			const wrapped = dotNL.add( wrap ).div( wrap.add( 1 ) ).clamp();
			// ② 明暗交界线（N·L 约 -0.4~0.2）混入蓝色 (0.55, 0.72, 1.0)
			// 月亮只有 15° 高，平地的 N·L 只有 0.26，所以蓝带上沿放到 0.4，大片雪面都带一点冷蓝，背光坡最蓝
			const terminator = smoothstep( - 0.45, - 0.1, dotNL ).mul( float( 1 ).sub( smoothstep( 0.15, 0.4, dotNL ) ) );
			const terminatorTint = mix( vec3( 1 ), vec3( 0.55, 0.72, 1.0 ), terminator.mul( uniforms.blueShadowToggle ) );
			const lambert = dotNL.clamp();
			const extra = terminatorTint.mul( wrapped ).sub( lambert ).max( lambert.negate() );
			reflectedLight.directDiffuse.addAssign( lightColor.mul( extra ).mul( BRDF_Lambert( { diffuseColor: diffuseContribution } ) ) );

		}

	}

	class SnowNodeMaterial extends THREE.MeshPhysicalNodeMaterial {

		setupLightingModel() {

			return new SnowLightingModel( this.useClearcoat, this.useSheen, this.useIridescence, this.useAnisotropy, this.useTransmission, this.useDispersion, this.useRetroreflection );

		}

	}

	const material = new SnowNodeMaterial();
	material.name = '雪';
	material.metalness = 0;
	material.ior = 1.31;   // 冰的折射率，菲涅尔高光更弱一点
	material.specularIntensity = 0.18;   // 雪是漫反射为主，镜面压低（否则掠射角像湿沙、像冰面），闪光交给闪光层

	const worldXZ = positionWorld.xz;
	const viewVector = cameraPosition.sub( positionWorld );
	const viewDistance = length( viewVector );
	const viewDirectionWorld = viewVector.div( viewDistance );
	// 像素足迹（米），后面颗粒按八度淡出、脚印选 mip 都用它
	const footprint = max( length( fwidth( positionWorld ) ), 1e-5 );

	// ---------- 脚印（7.4）：先判断这一点在不在路径附近 ----------
	const along = worldXZ.y.negate();
	const pathCenterX = pathXNode( worldXZ.y );
	const nearPath = abs( worldXZ.x.sub( pathCenterX ) ).lessThan( 0.6 ).and( along.greaterThan( 0.2 ) ).and( along.lessThan( - pathEndZ + 1 ) );
	// 图集是 512 宽 / (8 格 × 0.32 米) ≈ 200 像素每米
	const atlasTexelsPerMeter = atlasTileWidth / footTileWidth;
	const footLod = max( log2( footprint.mul( atlasTexelsPerMeter ) ), 0 );

	// 脚印 + 视差遮蔽：结果打包成 vec4( 采样用的 XZ, 脚印深度, 边缘堆雪 )；控制流必须放在 Fn 里
	const footprintSurface = Fn( () => {

		const sampleXZ = vec2( worldXZ ).toVar();
		const footprintValue = vec3( 0 ).toVar();

		If( nearPath.and( uniforms.footprintToggle.greaterThan( 0.5 ) ).and( viewDistance.lessThan( 70 ) ), () => {

			If( viewDistance.lessThan( 20 ), () => {

				// 视差遮蔽映射（POM）：沿视线往雪里走，每层比较脚印深度；找到交点后再二分 3 次
				const stepCount = uniforms.pomSteps;
				const layerStep = float( 1 ).div( stepCount.toFloat() );
				const shift = viewDirectionWorld.xz.negate().div( max( viewDirectionWorld.y, 0.2 ) ).mul( footprintDepthMax );
				const shiftStep = shift.mul( layerStep );
				const currentXZ = vec2( worldXZ ).toVar();
				const currentLayer = float( 0 ).toVar();
				const currentDepth = footprintSample( currentXZ, footLod ).x.toVar();

				Loop( { start: int( 0 ), end: stepCount, type: 'int', condition: '<' }, () => {

					If( currentLayer.greaterThanEqual( currentDepth ), () => {

						Break();

					} );
					currentXZ.addAssign( shiftStep );
					currentLayer.addAssign( layerStep );
					currentDepth.assign( footprintSample( currentXZ, footLod ).x );

				} );

				const previousXZ = currentXZ.sub( shiftStep ).toVar();
				const previousLayer = currentLayer.sub( layerStep ).toVar();
				for ( let i = 0; i < 3; i ++ ) {

					const middleXZ = previousXZ.add( currentXZ ).mul( 0.5 ).toVar();
					const middleLayer = previousLayer.add( currentLayer ).mul( 0.5 ).toVar();
					const middleDepth = footprintSample( middleXZ, footLod ).x;
					If( middleLayer.lessThan( middleDepth ), () => {

						previousXZ.assign( middleXZ );
						previousLayer.assign( middleLayer );

					} ).Else( () => {

						currentXZ.assign( middleXZ );
						currentLayer.assign( middleLayer );

					} );

				}

				sampleXZ.assign( currentXZ );

			} );

			// 50~70 米渐隐，不在 70 米处硬切
			const distanceFade = float( 1 ).sub( smoothstep( 50, 70, viewDistance ) );
			footprintValue.assign( footprintSample( sampleXZ, footLod ).mul( vec3( distanceFade, distanceFade, 1 ) ) );

		} );

		return vec4( sampleXZ, footprintValue.x, footprintValue.y );

	} )();

	const sampleXZ = footprintSurface.xy;
	const footprintValue = footprintSurface.zw;
	const footprintDepth = footprintValue.x;
	const footprintRim = footprintValue.y;
	// 脚印里面（压实的雪）的遮罩
	const insideFootprint = smoothstep( 0.05, 0.35, footprintDepth );

	// ---------- ④ 大尺度斑驳：10~60 米低频噪声，调粗糙度、闪光密度、法线强度；反照率只做两级小变化 ----------
	const mottleRoughnessField = fbm2D( worldXZ.div( 38 ), 3 );
	const mottleSparkleField = fbm2D( worldXZ.div( 24 ).add( vec2( 41, 17 ) ), 3 );
	const mottleNormalField = fbm2D( worldXZ.div( 15 ).add( vec2( - 23, 58 ) ), 2 );
	const mottleTintField = fbm2D( worldXZ.div( 52 ).add( vec2( 7, - 31 ) ), 2 );
	const mottleSmallField = valueNoise2D( worldXZ.div( 3.5 ) );
	const mottle = uniforms.mottleToggle;

	const roughnessBase = mix( float( 0.55 ), mix( 0.4, 0.75, smoothstep( 0.3, 0.7, mottleRoughnessField ) ), mottle );
	const sparkleDensity = mix( float( 0.6 ), smoothstep( 0.32, 0.68, mottleSparkleField ), mottle ).mul( insideFootprint.oneMinus() );
	const normalStrength = mix( float( 1 ), mix( 0.55, 1.35, smoothstep( 0.3, 0.7, mottleNormalField ) ), mottle );

	// ---------- ③ 风纹：坐标转到风向后按 (0.15, 1.2) 拉伸采样 fbm，只作用在法线上 ----------
	const windAngle = auroraConfig.windDirection * Math.PI / 180;
	const windAlong = worldXZ.x.mul( Math.cos( windAngle ) ).add( worldXZ.y.mul( Math.sin( windAngle ) ) );
	const windAcross = worldXZ.x.mul( - Math.sin( windAngle ) ).add( worldXZ.y.mul( Math.cos( windAngle ) ) );
	// fbm 的标准差只有 0.13 左右，乘 0.18 后起伏约 ±2.5 厘米、坡度约 10°，低角度月光下才拉得出细长明暗条纹
	const rippleLarge = fbm2D( vec2( windAlong.mul( 0.15 ), windAcross.mul( 1.2 ) ), 3 ).sub( 0.5 ).mul( 0.085 );
	const rippleFine = fbm2D( vec2( windAlong.mul( 0.45 ), windAcross.mul( 3.6 ) ).add( 13 ), 2 ).sub( 0.5 ).mul( 0.025 );
	// 细风纹在远处淡出（2 个像素以下就是噪点）
	const rippleFineFade = float( 1 ).sub( smoothstep( 0.1, 0.35, footprint.mul( 3.6 ) ) );
	const rippleHeight = rippleLarge.add( rippleFine.mul( rippleFineFade ) ).mul( uniforms.windToggle );

	// ---------- ⑤ 颗粒：F2-F1 脊线 3 个八度 + value noise 各一半；按像素足迹逐个八度淡出 ----------
	const grainBaseFrequency = 1 / 0.022;    // 最粗一级 2.2 厘米
	const grainFrequencies = [ grainBaseFrequency, grainBaseFrequency * 1.9, grainBaseFrequency * 1.9 * 2.3 ];
	const grainAmplitudes = [ 0.002, 0.0012, 0.0006 ];

	function grainHeightAt( planeCoordinate ) {

		// 先 domain warp：p += 0.35 * fbm(p * 0.5)，打破细胞形状的规则感
		const warped = domainWarp2D( planeCoordinate.mul( grainBaseFrequency ), 0.35, 0.5, 2 );
		// 再用一层低频噪声让颗粒强弱成片变化，避免整片同一个纹样
		const patchiness = smoothstep( 0.2, 0.8, valueNoise2D( planeCoordinate.mul( 1.7 ) ) ).mul( 0.7 ).add( 0.3 );
		let total = float( 0 );
		let point = warped;
		for ( let i = 0; i < grainFrequencies.length; i ++ ) {

			const scaleFromBase = grainFrequencies[ i ] / grainBaseFrequency;
			const cells = voronoi2D( point.mul( scaleFromBase ), float( 0.95 ), float( 0.8 ) );
			// F2-F1：细胞内部鼓、边界是细沟，叠起来像压在一起的雪粒
			const ridge = clamp( cells.y.sub( cells.x ).mul( 1.6 ), 0, 1 );
			const soft = valueNoise2D( point.mul( scaleFromBase * 1.3 ).add( 31 ) );
			const octave = mix( ridge, soft, 0.5 );
			// 一个格子小于约 2.5 像素就开始淡出（footprint × 频率 = 每格占多少分之一像素）
			const fade = float( 1 ).sub( smoothstep( 0.3, 0.8, footprint.mul( grainFrequencies[ i ] ) ) );
			total = total.add( octave.sub( 0.5 ).mul( grainAmplitudes[ i ] ).mul( fade ) );
			// 八度之间旋转坐标
			point = vec2( point.x.mul( 0.8 ).sub( point.y.mul( 0.6 ) ), point.x.mul( 0.6 ).add( point.y.mul( 0.8 ) ) ).add( 7.3 );

		}

		return total.mul( patchiness );

	}

	const grainHeight = Fn( () => {

		const height = grainHeightAt( sampleXZ ).toVar();
		// 只在陡坡（|N.y| < 0.7）混 triplanar，平地不用
		const steepness = abs( normalWorldGeometry.y );
		If( steepness.lessThan( 0.7 ), () => {

			const blend = float( 1 ).sub( smoothstep( 0.5, 0.7, steepness ) );
			const weightX = abs( normalWorldGeometry.x );
			const weightZ = abs( normalWorldGeometry.z );
			const weightSum = weightX.add( weightZ ).max( 1e-3 );
			const sideHeight = grainHeightAt( positionWorld.zy ).mul( weightX ).add( grainHeightAt( positionWorld.xy ).mul( weightZ ) ).div( weightSum );
			height.assign( mix( height, sideHeight, blend ) );

		} );
		return height;

	} )();

	// ---------- 总高度 → 法线 ----------
	const footprintHeight = footprintDepth.mul( - footprintDepthMax ).add( footprintRim.mul( footprintRimHeight ) );
	const totalHeight = rippleHeight
		.add( grainHeight.mul( uniforms.grainToggle ) )
		.mul( normalStrength )
		.add( footprintHeight );
	material.normalNode = bumpNormal( positionView, normalViewGeometry, totalHeight );

	// ---------- ① 基础颜色：线性反照率 0.86~0.93，带一点蓝；斑驳只给 ±6% 冷暖 + ±3% 明暗 ----------
	const albedo = vec3( ...auroraConfig.snowAlbedo );
	const coolTint = vec3( 0.95, 0.98, 1.06 );
	const warmTint = vec3( 1.05, 1.01, 0.95 );
	const largeTint = mix( coolTint, warmTint, smoothstep( 0.3, 0.7, mottleTintField ) );
	const smallShade = float( 1 ).add( mottleSmallField.sub( 0.5 ).mul( 0.06 ) );
	const mottledAlbedo = mix( albedo, albedo.mul( largeTint ).mul( smallShade ), mottle );
	// 脚印里反照率降 4%，蓝色加强（凹坑里的蓝影）
	const footprintTint = mix( vec3( 1 ), vec3( 0.86, 0.92, 1.05 ), uniforms.blueShadowToggle );
	// 斑驳会把某个通道推到 0.92 以上，夹住：雪的反照率不能接近 1
	material.colorNode = min( mottledAlbedo.mul( mix( vec3( 1 ), footprintTint.mul( 0.96 ), insideFootprint ) ), vec3( 0.92 ) );

	material.roughnessNode = roughnessBase.sub( insideFootprint.mul( 0.15 ) ).clamp( 0.15, 1 );
	// 凹坑里间接光少一些
	material.aoNode = float( 1 ).sub( footprintDepth.mul( 0.35 ) );

	// ---------- ⑥ 绒光：Charlie sheen，淡蓝白；乘极光照明（天上绿一点，绒光也带一点绿）----------
	// 绒光强度 0.4：再高掠射角会像一层釉，雪就成冰面了
	material.sheenNode = color( auroraConfig.sheenColor ).mul( 0.4 ).add( uniforms.auroraLightColor.mul( 0.5 ) ).mul( uniforms.sheenToggle );
	material.sheenRoughnessNode = float( auroraConfig.sheenRoughness );

	// ---------- ⑦ 前向散射 + 棱线透光 → emissive ----------
	const moonDirection = uniforms.moonDirection;
	const surfaceNormal = normalWorld;
	const dotNV = max( dot( surfaceNormal, viewDirectionWorld ), 0 );
	const backLight = max( dot( viewDirectionWorld, moonDirection.negate() ), 0 );
	const scatterColor = color( auroraConfig.scatterColor ).mul( uniforms.moonColor );
	// 逆光瓣：pow(V·(-L), 6) · pow(1 - N·V, 2)，镜头朝月亮看时雪丘轮廓发亮
	const forwardScatter = pow( backLight, 6 ).mul( float( 1 ).sub( dotNV ).pow2() ).mul( auroraConfig.forwardScatter ).mul( uniforms.forwardToggle );
	// 棱线透光：高度场拉普拉斯为负（凸）的地方是雪丘棱线，薄处透光
	const curvature = texture( state.heightTexture, terrainUV( worldXZ ) ).g;
	const ridge = smoothstep( 0.0, 0.06, curvature.negate() );
	const ridgeGlow = ridge.mul( backLight.pow2() ).mul( float( 0.35 ).add( pow( max( float( 1 ).sub( dotNV ), 0 ), 3 ) ) ).mul( auroraConfig.ridgeGlow ).mul( uniforms.ridgeToggle );

	// ---------- ⑧ 闪光：月光算一次，极光（朝上偏北）也算一次 ----------
	const sparkleInputs = {
		position: positionWorld,
		normal: surfaceNormal,
		viewDirection: viewDirectionWorld,
		density: sparkleDensity.mul( uniforms.sparkleToggle ),
		levels: sparkleLevels,
	};
	const moonLightColor = uniforms.moonColor;
	const auroraLightDirection = normalize( vec3( 0, 1, - 0.5 ) );
	// 三层：细密近景、中景、少量又大又亮的"钻石"
	const layerSettings = [
		// 半径按像素足迹的短边算，1.2 像素左右：再小就落到像素中心之间，整颗丢掉
		{ cellSize: 0.03, existProbability: 0.3, sharpness: 260, intensity: 1.0, radiusPixels: 1.2, cellPixels: 4, seed: 1 },
		{ cellSize: 0.1, existProbability: 0.22, sharpness: 220, intensity: 1.4, radiusPixels: 1.3, cellPixels: 4, seed: 2 },
		{ cellSize: 0.4, existProbability: 0.08, sharpness: 200, intensity: 3.0, radiusPixels: 1.8, cellPixels: 4, seed: 3 },
	];
	const sparkleTotal = Fn( () => {

		const total = vec3( 0 ).toVar();
		for ( let i = 0; i < layerSettings.length; i ++ ) {

			const layer = layerSettings[ i ];
			const addLayer = () => {

				// 月亮只有 15° 高：微法线锥要放宽到 80°，否则只有正对月亮的坡上才可能闪（雪晶的朝向本来就很散），朝月亮看时才有一片碎闪
				total.addAssign( sparkleLayer( {
					...sparkleInputs, ...layer,
					coneDegrees: 80,
					lightDirection: moonDirection, lightColor: moonLightColor,
					intensity: layer.intensity * auroraConfig.sparkleIntensity,
				} ) );
				// 极光从头顶照下来，用规格书的 22° 锥就够
				total.addAssign( sparkleLayer( {
					...sparkleInputs, ...layer,
					coneDegrees: 22,
					seed: layer.seed + 10,
					// 极光光照色本身只有 0.1~0.2（它是半球光的量级），乘 8 才和月光闪点同一量级
				lightDirection: auroraLightDirection, lightColor: uniforms.auroraLightColor.mul( 8 ),
					intensity: layer.intensity * auroraConfig.sparkleIntensity,
				} ) );

			};

			// 第一层总是有；后两层按档位开（uniform 分支，整片像素走同一路，不浪费）
			if ( i === 0 ) addLayer();
			else If( uniforms.sparkleLayerCount.greaterThan( i + 0.5 ), addLayer );

		}

		return total;

	} )();

	material.emissiveNode = scatterColor.mul( forwardScatter.add( ridgeGlow ) ).add( sparkleTotal );

	return material;

}

// ===================== 极光（半球贴图）=====================

function createAuroraPass( renderer ) {

	const auroraConfig = state.ctx.config.aurora;
	const uniforms = state.uniforms;

	const makeTarget = ( width, height ) => {

		const target = new THREE.RenderTarget( width, height, { type: THREE.HalfFloatType, depthBuffer: false } );
		target.texture.wrapS = THREE.RepeatWrapping;
		target.texture.wrapT = THREE.ClampToEdgeWrapping;
		target.texture.minFilter = THREE.LinearFilter;
		target.texture.magFilter = THREE.LinearFilter;
		target.texture.generateMipmaps = false;
		return target;

	};

	const targets = [ makeTarget( 16, 8 ), makeTarget( 16, 8 ) ];
	const previousNode = texture( targets[ 0 ].texture );

	// 三条帘幕：z0 = 帘幕在极光平面上离人多远（越大越靠地平线），width 是帘幕厚度，bend 是弧形弯曲幅度
	const curtains = [
		{ z0: - 0.35, width: 0.07, strength: 0.7, phase: 0.0, bend: 0.8 },
		{ z0: - 1.3, width: 0.1, strength: 1.0, phase: 2.1, bend: 0.8 },
		{ z0: - 2.6, width: 0.14, strength: 0.85, phase: 4.3, bend: 1.1 },
	];

	const green = color( '#3dffa0' );
	const purple = color( '#9a4dff' );
	const red = color( '#ff5f7e' );

	const auroraColor = Fn( () => {

		const mapUV = uv();
		const direction = hemisphereDirection( mapUV );
		const time = uniforms.sceneTime;
		const steps = uniforms.auroraSteps;
		const stepCount = steps.toFloat();

		// 每个像素的起始偏移用哈希抖动，配合时间累积去掉分层条纹
		const pixel = floor( mapUV.mul( uniforms.auroraResolution ) );
		const jitter = hash21( pixel.add( vec2( uniforms.frameIndex.mul( 17 ), uniforms.frameIndex.mul( 59 ) ) ) );

		const accumulated = vec3( 0 ).toVar();
		const viewY = max( direction.y, 0.03 );
		// 人在地上走几百米，极光几乎不动：只给极小的视差
		const cameraOffset = cameraPosition.xz.mul( 0.0004 );

		Loop( { start: int( 0 ), end: steps, type: 'int', condition: '<' }, ( { i } ) => {

			// 层高随层号非线性增加：底部采得密（帘幕下缘最亮最细）
			const layerFraction = pow( i.toFloat().add( jitter ).div( stepCount ), 1.35 );
			const altitude = float( 1 ).add( layerFraction.mul( 1.6 ) );
			// 视线和这一层水平面的交点：t = (高度 - 相机高度) / 视线.y，相机高度在这个尺度下当 0
			const planePoint = direction.xz.mul( altitude.div( viewY ) ).add( cameraOffset );

			for ( const curtain of curtains ) {

				// 帘幕位置：先做一次低频弯曲 x += 0.8·sin(z·0.2 + t·0.05) 形成弧形光带，再叠一层更碎的弯
				// 再加一层沿 x 的小褶皱，帘幕像布一样有折
				const curtainLine = float( curtain.z0 )
					.add( sin( planePoint.x.mul( 0.22 ).add( time.mul( 0.05 ) ).add( curtain.phase ) ).mul( curtain.bend ) )
					.add( sin( planePoint.x.mul( 0.8 ).sub( time.mul( 0.07 ) ).add( curtain.phase * 2 ) ).mul( 0.22 ) )
					.add( valueNoise2D( vec2( planePoint.x.mul( 3.0 ).add( time.mul( 0.03 ) ), curtain.phase + 21 ) ).sub( 0.5 ).mul( 0.12 ) );
				const across = planePoint.y.sub( curtainLine ).div( curtain.width );
				const sheet = exp( across.mul( across ).negate() );

				// 竖向光线：只沿帘幕方向（x）变化的高频噪声，每一层用同一个 x，所以在天上拉成竖条；缓慢横向漂移
				const rayCoordinate = planePoint.x.mul( 26 ).add( time.mul( auroraConfig.auroraDrift ) ).add( curtain.phase * 10 );
				const rays = valueNoise2D( vec2( rayCoordinate, curtain.phase ) ).mul( 0.6 ).add( valueNoise2D( vec2( rayCoordinate.mul( 2.7 ), curtain.phase + 5 ) ).mul( 0.4 ) );
				// 光线之外再有一层很慢的明暗分段：有的段亮、有的段几乎断开
				const segment = smoothstep( 0.25, 0.75, valueNoise2D( vec2( planePoint.x.mul( 1.1 ).add( time.mul( 0.012 ) ), curtain.phase + 13 ) ) );
				const rayShape = pow( rays, 2.6 ).mul( 2.2 ).add( 0.06 ).mul( segment.mul( 0.85 ).add( 0.15 ) );

				// 帘幕下缘高度沿 x 起伏，下缘清晰、往上慢慢淡
				const bottom = float( 0.03 ).add( valueNoise2D( vec2( planePoint.x.mul( 0.9 ).add( time.mul( 0.02 ) ), curtain.phase + 9 ) ).mul( 0.12 ) );
				const heightAboveBottom = layerFraction.sub( bottom );
				const rise = smoothstep( 0.0, 0.03, heightAboveBottom );
				// 往上慢慢淡；下缘再额外亮一截（真实极光下缘最亮最锐）
				const decay = exp( max( heightAboveBottom, 0 ).mul( - 2.2 ) ).mul( float( 1 ).add( exp( max( heightAboveBottom, 0 ).mul( - 22 ) ).mul( 1.5 ) ) );

				// 按层高着色：底部一窄条品红紫（氮分子），主体绿（氧 557.7nm），顶部淡红（氧 630nm）
				const purpleWeight = float( 1 ).sub( smoothstep( 0.0, 0.07, heightAboveBottom ) );
				const redWeight = smoothstep( 0.35, 0.85, heightAboveBottom );
				const greenWeight = max( float( 1 ).sub( purpleWeight ).sub( redWeight ), 0 );
				const layerColor = purple.mul( purpleWeight.mul( 0.9 ) ).add( green.mul( greenWeight ) ).add( red.mul( redWeight.mul( 0.5 ) ) );

				// 每条帘幕各自呼吸（5~15 秒周期）
				const breath = float( 0.75 ).add( sin( time.mul( Math.PI * 2 / auroraConfig.auroraBreathPeriod ).add( curtain.phase ) ).mul( 0.25 ) );
				const density = sheet.mul( rayShape ).mul( rise ).mul( decay ).mul( curtain.strength ).mul( breath );
				accumulated.addAssign( layerColor.mul( density ) );

			}

		} );

		// 地平线附近淡出，天顶附近也减弱
		const horizonFade = smoothstep( 0.02, 0.2, direction.y );
		const zenithFade = float( 1 ).sub( smoothstep( 0.8, 1.0, direction.y ).mul( 0.5 ) );
		// 6 / 步数：按层数归一化，步数变了亮度不变；6 是让主帘幕亮处落在 HDR 1~3 的经验值
		const current = accumulated.mul( float( 6 ).div( stepCount ) ).mul( horizonFade ).mul( zenithFade ).mul( uniforms.auroraBrightness );

		// 时间累积（指数滑动平均，alpha ≈ 0.1）：贴图是按方向存的，转头不会拖影
		const previous = previousNode.sample( mapUV ).rgb;
		return vec4( mix( previous, current, uniforms.auroraBlend ), 1 );

	} );

	const material = new THREE.NodeMaterial();
	material.name = '极光半球贴图';
	material.fragmentNode = auroraColor();
	const quad = new THREE.QuadMesh( material );

	// 降采样成一个平均色：8×8 个方向加权平均（越靠上权重越大），给雪地当"极光照明"
	const averageTarget = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, depthBuffer: false } );
	const currentNode = texture( targets[ 1 ].texture );
	const averageMaterial = new THREE.NodeMaterial();
	averageMaterial.name = '极光平均色';
	averageMaterial.fragmentNode = Fn( () => {

		let sum = vec3( 0 );
		let weightSum = 0;
		for ( let j = 0; j < 8; j ++ ) {

			for ( let i = 0; i < 8; i ++ ) {

				const sampleV = ( j + 0.5 ) / 8;
				const weight = Math.sin( sampleV * sampleV * Math.PI / 2 ) + 0.2;
				sum = sum.add( currentNode.sample( vec2( ( i + 0.5 ) / 8, sampleV ) ).level( 0 ).rgb.mul( weight ) );
				weightSum += weight;

			}

		}

		return vec4( sum.div( weightSum ), 1 );

	} )();
	const averageQuad = new THREE.QuadMesh( averageMaterial );

	// QuadMesh 的几何体是模块级共享的（QuadMesh.js），后期管线也在用，不归这个场景释放
	state.disposables.push( targets[ 0 ], targets[ 1 ], averageTarget, material, averageMaterial );

	let writeIndex = 1;
	let freshTargets = true;

	return {
		targets,
		averageTarget,
		// 天空材质里采样的节点，每帧换成刚写好的那张
		readNode: texture( targets[ 1 ].texture ),
		setResolution( width, height ) {

			if ( targets[ 0 ].width === width && targets[ 0 ].height === height ) return;
			targets[ 0 ].setSize( width, height );
			targets[ 1 ].setSize( width, height );
			uniforms.auroraResolution.value.set( width, height );
			// 换尺寸后旧内容作废，下一帧不累积（否则极光会从黑色慢慢淡入）
			freshTargets = true;

		},
		render( blend ) {

			const readIndex = 1 - writeIndex;
			previousNode.value = targets[ readIndex ].texture;
			uniforms.auroraBlend.value = freshTargets ? 1 : blend;
			freshTargets = false;
			const previousTarget = renderer.getRenderTarget();
			renderer.setRenderTarget( targets[ writeIndex ] );
			quad.render( renderer );
			this.readNode.value = targets[ writeIndex ].texture;
			currentNode.value = targets[ writeIndex ].texture;
			renderer.setRenderTarget( averageTarget );
			averageQuad.render( renderer );
			renderer.setRenderTarget( previousTarget );
			writeIndex = readIndex;

		},
	};

}

// 隔几帧把平均色读回 CPU（异步，不卡帧），给半球光和闪光用
function requestAverageReadback( renderer ) {

	if ( state.readbackPending || ! state.auroraPass ) return;
	state.readbackPending = true;
	const target = state.auroraPass.averageTarget;

	renderer.readRenderTargetPixelsAsync( target, 0, 0, 1, 1 ).then( ( pixels ) => {

		state.readbackPending = false;
		if ( ! state.ready || ! pixels ) return;
		const read = ( index ) => ( pixels instanceof Uint16Array ) ? THREE.DataUtils.fromHalfFloat( pixels[ index ] ) : pixels[ index ];
		const red = read( 0 );
		const green = read( 1 );
		const blue = read( 2 );
		if ( Number.isFinite( red ) && Number.isFinite( green ) && Number.isFinite( blue ) ) {

			state.auroraAverageColor.setRGB( Math.max( 0, red ), Math.max( 0, green ), Math.max( 0, blue ), THREE.LinearSRGBColorSpace );

		}

	} ).catch( ( error ) => {

		state.readbackPending = false;
		// 场景已经释放时，未完成的读回被取消是正常的，不报
		if ( ! state.ready ) return;
		console.warn( '雪原场景：极光平均色读回失败，本次沿用上一次的颜色：', error );

	} );

}

// ===================== 天空 =====================

function createSkyDome() {

	const auroraConfig = state.ctx.config.aurora;
	const uniforms = state.uniforms;

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '天空';
	material.side = THREE.BackSide;
	material.depthWrite = false;
	material.fog = false;

	material.colorNode = Fn( () => {

		const direction = normalize( positionWorld.sub( cameraPosition ) );
		const elevation = clamp( direction.y, 0, 1 );
		// 地平线 #0d1730 → 天顶 #03060f；地平线附近渐变放慢，暗部不至于一片死黑
		const gradient = mix( color( auroraConfig.skyHorizon ), color( auroraConfig.skyZenith ), pow( elevation, 0.45 ) );
		// 地平线下面（远山缝隙）延续地平线色
		const below = color( auroraConfig.skyHorizon ).mul( 0.85 );
		const base = direction.y.lessThan( 0 ).select( below, gradient );

		// 月亮那一侧的地平线稍亮一点
		const moonSideGlow = pow( max( dot( normalize( vec3( direction.x, 0, direction.z ) ), normalize( vec3( uniforms.moonDirection.x, 0, uniforms.moonDirection.z ) ) ), 0 ), 4 )
			.mul( exp( elevation.mul( - 7 ) ) ).mul( 0.05 );
		const moonSide = uniforms.moonBaseColor.mul( moonSideGlow );

		// 地平线附近换成雾的颜色（同一个公式：底色 + 前向散射），远山、远处雪面和天空接得上
		const fogPhase = henyeyGreenstein( dot( direction, uniforms.moonDirection ), float( 0.6 ) );
		const fogSky = color( auroraConfig.fogColor ).add( uniforms.auroraLightColor.mul( 0.15 ) ).add( color( auroraConfig.fogScatterColor ).mul( fogPhase.mul( 0.25 ) ) );
		const horizonBlend = float( 1 ).sub( smoothstep( 0.0, 0.12, direction.y ) ).mul( uniforms.fogAmount );

		const aurora = state.auroraPass.readNode.sample( hemisphereUV( direction ) ).rgb.mul( uniforms.auroraToggle ).mul( step( 0, direction.y ) );
		const stars = starField( {
			direction,
			time: uniforms.sceneTime,
			density: 0.07,
			gridScale: 210,
			brightness: 0.8,
			dimming: clamp( luminance( aurora ).mul( 3 ), 0, 0.95 ),
		} ).mul( smoothstep( 0.02, 0.25, direction.y ) );
		const moon = moonGlow( { direction, moonDirection: uniforms.moonDirection, color: uniforms.moonBaseColor, intensity: 14, innerHalo: 0.35, outerHalo: 0.05 } );

		return mix( base.add( moonSide ), fogSky, horizonBlend ).add( aurora ).add( stars ).add( moon );

	} )();

	const dome = new THREE.Mesh( new THREE.SphereGeometry( 1500, 64, 32 ), material );
	dome.name = '天空球';
	dome.renderOrder = - 10;
	dome.frustumCulled = false;
	state.disposables.push( dome.geometry, material );
	return dome;

}

// 地形外面一圈平的雪（海拔 0），一直铺到远山脚下；地形边缘已经落到 0。
// 用和地形同一个雪材质，明暗、颜色、斑驳都连续，接缝看不出
function createOuterSnow( snowMaterial ) {

	const size = state.terrainSize;
	const reach = 700;
	const centerZ = state.terrainCenterZ;
	const strips = [
		// 北、南两条（整宽），东、西两条（只覆盖中间）
		{ width: size + reach * 2, depth: reach, x: 0, z: centerZ - size / 2 - reach / 2 },
		{ width: size + reach * 2, depth: reach, x: 0, z: centerZ + size / 2 + reach / 2 },
		{ width: reach, depth: size, x: - size / 2 - reach / 2, z: centerZ },
		{ width: reach, depth: size, x: size / 2 + reach / 2, z: centerZ },
	];
	const geometries = strips.map( ( strip ) => {

		const geometry = new THREE.PlaneGeometry( strip.width, strip.depth, 1, 1 );
		geometry.rotateX( - Math.PI / 2 );
		geometry.translate( strip.x, 0, strip.z );
		return geometry;

	} );
	const merged = mergeGeometries( geometries, false );
	for ( const geometry of geometries ) geometry.dispose();
	if ( ! merged ) throw new Error( '雪原场景：外圈平雪几何体合并失败' );

	const mesh = new THREE.Mesh( merged, snowMaterial );
	mesh.name = '外圈平雪';
	mesh.receiveShadow = true;
	// 材质归地形登记释放，这里只登记几何体
	state.disposables.push( merged );
	return mesh;

}

// 远山剪影：一圈低矮的山，用雾溶进天空
function createDistantMountains() {

	const segments = 360;
	// 半径要大于地形角到中心的距离（约 495 米），走到地形角上远山也还在 150 米开外，不会变成一堵墙
	const radius = 560;
	const positions = [];
	const indices = [];

	for ( let i = 0; i <= segments; i ++ ) {

		const angle = i / segments * Math.PI * 2;
		const x = Math.sin( angle ) * radius;
		const z = state.terrainCenterZ - Math.cos( angle ) * radius;
		// 山高用两层噪声，绕一圈首尾相接（用圆上的坐标采样）
		const sampleX = Math.sin( angle ) * 6;
		const sampleY = Math.cos( angle ) * 6;
		const height = 17 + jsFbm2D( sampleX + 11, sampleY + 3, 4 ) * 50 + Math.pow( jsValueNoise2D( sampleX * 2.5, sampleY * 2.5 ), 3 ) * 24;
		positions.push( x, - 20, z, x, height, z );

	}

	for ( let i = 0; i < segments; i ++ ) {

		const bottomLeft = i * 2;
		indices.push( bottomLeft, bottomLeft + 2, bottomLeft + 1, bottomLeft + 1, bottomLeft + 2, bottomLeft + 3 );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setIndex( indices );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '远山';
	material.side = THREE.DoubleSide;
	// 山脚暗、山顶被月光擦亮一点
	const top = positionWorld.y.div( 85 ).clamp( 0, 1 );
	material.colorNode = mix( color( '#0a1124' ), color( '#1f2c4f' ), pow( top, 1.5 ) );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = '远山';
	state.disposables.push( geometry, material );
	return mesh;

}

// ===================== 岩石、枯树 =====================

function createRocks() {

	const group = new THREE.Group();
	group.name = '岩石';

	const material = new THREE.MeshStandardNodeMaterial();
	material.name = '岩石';
	// 顶部按法线朝上的程度盖雪，过渡带噪声；贴地处一圈堆雪
	const snowNoise = fbm2D( positionWorld.xz.mul( 2.2 ).add( positionWorld.y ), 3 ).sub( 0.5 ).mul( 0.5 );
	const capMask = smoothstep( 0.35, 0.7, normalWorld.y.add( snowNoise ) );
	const ground = texture( state.heightTexture, terrainUV( positionWorld.xz ) ).r;
	const baseMask = float( 1 ).sub( smoothstep( 0.04, 0.22, positionWorld.y.sub( ground ) ) );
	const snowMask = max( capMask, baseMask ).clamp();
	const rockColor = mix( color( '#0c0d10' ), color( '#1a1b1f' ), fbm2D( positionWorld.xz.mul( 6 ).add( positionWorld.y.mul( 4 ) ), 2 ) );
	material.colorNode = mix( rockColor, vec3( ...state.ctx.config.aurora.snowAlbedo ), snowMask );
	material.roughnessNode = mix( float( 0.9 ), float( 0.6 ), snowMask );
	material.metalness = 0;
	// 岩石本身几乎不反射环境光，免得被极光照成一块绿玻璃
	material.aoNode = mix( float( 0.35 ), float( 1 ), snowMask );

	for ( const spot of state.rockSpots ) {

		// Icosahedron 是非索引几何，先按位置合并顶点，否则推完每个三角形各自一个法线，成了玻璃块
		const geometry = mergeVertices( new THREE.IcosahedronGeometry( 1, 4 ).deleteAttribute( 'normal' ).deleteAttribute( 'uv' ) );
		const positions = geometry.attributes.position;
		const point = new THREE.Vector3();
		for ( let i = 0; i < positions.count; i ++ ) {

			point.fromBufferAttribute( positions, i );
			// 沿径向用噪声推，做出不规则的块面
			const bump = jsFbm2D( point.x * 1.7 + spot.seed, point.y * 1.7 + point.z * 1.3, 3 );
			const facet = Math.round( jsValueNoise2D( point.x * 3 + spot.seed, point.z * 3 ) * 3 ) / 3;
			point.multiplyScalar( 0.75 + bump * 0.45 + facet * 0.08 );
			// 底部压平
			if ( point.y < - 0.35 ) point.y = - 0.35 + ( point.y + 0.35 ) * 0.3;
			positions.setXYZ( i, point.x, point.y, point.z );

		}

		geometry.computeVertexNormals();
		geometry.scale( spot.size * 1.1, spot.size * 0.75, spot.size * 0.9 );
		geometry.rotateY( spot.seed );

		const mesh = new THREE.Mesh( geometry, material );
		// 半埋进雪里
		mesh.position.set( spot.x, heightAt( spot.x, spot.z ) - spot.size * 0.3, spot.z );
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		group.add( mesh );
		state.disposables.push( geometry );

	}

	state.disposables.push( material );
	return group;

}

function createDeadTree( basePosition ) {

	const geometries = [];
	const up = new THREE.Vector3( 0, 1, 0 );
	let segmentCount = 0;

	// 伪随机，保证每次一样
	let randomSeed = 7;
	const random = () => {

		randomSeed += 1;
		return jsHash21( randomSeed, 91 );

	};

	function addSegment( start, end, radiusStart, radiusEnd ) {

		const direction = new THREE.Vector3().subVectors( end, start );
		const length = direction.length();
		const geometry = new THREE.CylinderGeometry( radiusEnd, radiusStart, length, 6, 1, false );
		geometry.translate( 0, length / 2, 0 );
		const quaternion = new THREE.Quaternion().setFromUnitVectors( up, direction.normalize() );
		geometry.applyQuaternion( quaternion );
		geometry.translate( start.x, start.y, start.z );
		geometries.push( geometry );
		segmentCount ++;

	}

	// 递归分叉：每根枝分两段（中间折一下更像枯枝），末端分 2~3 根
	function grow( start, direction, length, radius, depth ) {

		if ( depth > 6 || radius < 0.015 || segmentCount > 600 ) return;

		const bend = new THREE.Vector3( random() - 0.5, random() * 0.3, random() - 0.5 ).multiplyScalar( 0.35 );
		const middle = start.clone().add( direction.clone().multiplyScalar( length * 0.5 ) );
		const secondDirection = direction.clone().add( bend ).normalize();
		const end = middle.clone().add( secondDirection.clone().multiplyScalar( length * 0.5 ) );
		const middleRadius = radius * 0.85;
		const endRadius = radius * 0.7;
		addSegment( start, middle, radius, middleRadius );
		addSegment( middle, end, middleRadius, endRadius );

		const childCount = depth < 2 ? 3 : ( random() > 0.4 ? 2 : 3 );
		for ( let i = 0; i < childCount; i ++ ) {

			const spread = 0.45 + random() * 0.4;
			const azimuth = ( i / childCount ) * Math.PI * 2 + random() * 1.2;
			const sideways = new THREE.Vector3( Math.cos( azimuth ), 0, Math.sin( azimuth ) );
			// 往上长的趋势，枝条略往上翘
			const childDirection = secondDirection.clone().multiplyScalar( Math.cos( spread ) )
				.add( sideways.multiplyScalar( Math.sin( spread ) ) )
				.add( new THREE.Vector3( 0, 0.25, 0 ) )
				.normalize();
			grow( end, childDirection, length * ( 0.62 + random() * 0.15 ), endRadius * 0.78, depth + 1 );

		}

	}

	grow( new THREE.Vector3( 0, - 0.5, 0 ), new THREE.Vector3( 0.05, 1, 0 ).normalize(), 4.2, 0.34, 0 );

	const merged = mergeGeometries( geometries, false );
	for ( const geometry of geometries ) geometry.dispose();
	if ( ! merged ) throw new Error( '雪原场景：枯树几何体合并失败' );

	const material = new THREE.MeshStandardNodeMaterial();
	material.name = '枯树';
	// 黑色剪影，枝条朝上的一面挂一点雪
	const snowOnBranch = smoothstep( 0.55, 0.85, normalWorld.y.add( valueNoise2D( positionWorld.xz.mul( 14 ).add( positionWorld.y.mul( 9 ) ) ).sub( 0.5 ).mul( 0.4 ) ) );
	material.colorNode = mix( color( '#040506' ), vec3( ...state.ctx.config.aurora.snowAlbedo ), snowOnBranch.mul( 0.75 ) );
	material.roughness = 1;
	material.metalness = 0;

	const mesh = new THREE.Mesh( merged, material );
	mesh.name = '枯树';
	mesh.position.copy( basePosition );
	mesh.castShadow = true;
	state.disposables.push( merged, material );
	return mesh;

}

// ===================== 飘雪（全 GPU）=====================

function createFallingSnow( { count, boxSize, size, stretch, seedOffset, brightness } ) {

	const uniforms = state.uniforms;
	const auroraConfig = state.ctx.config.aurora;
	const material = new THREE.SpriteNodeMaterial();
	material.name = '飘雪';
	material.transparent = true;
	material.depthWrite = false;

	const index = instanceIndex.toFloat();
	const seed = hash33( vec3( index, seedOffset, 1 ) );
	const seedB = hash33( vec3( index, seedOffset, 2 ) );
	const time = uniforms.sceneTime;
	const windAngle = auroraConfig.windDirection * Math.PI / 180;
	const fallSpeed = mix( 0.5, 1.1, seedB.x );
	// 速度 = 风 + 下落；风的水平分量 0.6~1.4 米/秒
	const velocity = vec3( Math.cos( windAngle ), 0, Math.sin( windAngle ) ).mul( mix( 0.6, 1.4, seedB.y ) ).add( vec3( 0, fallSpeed.negate(), 0 ) );
	const box = float( boxSize );
	// 位置 = 种子 + 速度 × 时间 + curl 噪声扰动，在相机周围的立方体里取模循环（JS 里不逐帧更新任何粒子）
	// curl 在粒子"没扰动时的位置"上采样，雪片沿途经过不同的涡，轨迹才是飘的
	const basePosition = seed.mul( box ).add( velocity.mul( time ) );
	const drifted = basePosition.add( curlNoise3D( basePosition.mul( 0.15 ).add( vec3( 0, time.mul( 0.05 ), 0 ) ) ).mul( 1.4 ) );
	const relative = drifted.sub( cameraPosition ).add( box.mul( 0.5 ) );
	const wrapped = relative.sub( box.mul( floor( relative.div( box ) ) ) ).sub( box.mul( 0.5 ) );
	material.positionNode = wrapped.add( cameraPosition );

	// 沿速度方向拉长（像有运动模糊）：把速度转到视图空间，算它在屏幕上的角度
	const viewVelocity = cameraViewMatrix.mul( vec4( velocity, 0 ) ).xyz;
	material.rotationNode = atan( viewVelocity.x.negate(), viewVelocity.y );
	const flakeSize = mix( size * 0.6, size * 1.4, seedB.z );
	material.scaleNode = vec2( flakeSize, flakeSize.mul( stretch ) );

	// 软圆点；离相机太近、靠近循环盒边缘时淡出，避免突然出现
	const centered = uv().sub( 0.5 ).mul( 2 );
	const disc = float( 1 ).sub( smoothstep( 0.0, 1.0, length( centered ) ) );
	const distance = length( wrapped );
	const fade = smoothstep( 0.4, 1.2, distance ).mul( float( 1 ).sub( smoothstep( boxSize * 0.38, boxSize * 0.5, distance ) ) );
	material.colorNode = uniforms.moonColor.mul( 0.25 ).add( uniforms.auroraLightColor.mul( 0.6 ) ).add( vec3( 0.06, 0.08, 0.12 ) ).mul( brightness );
	material.opacityNode = disc.mul( fade ).mul( 0.6 );

	const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), material );
	mesh.name = '飘雪';
	mesh.count = count;
	mesh.frustumCulled = false;
	state.disposables.push( mesh.geometry, material );
	return mesh;

}

// ===================== 地吹雪 =====================

function createBlowingBand( layerHeight, layerIndex ) {

	const uniforms = state.uniforms;
	const auroraConfig = state.ctx.config.aurora;
	const patchSize = 90;
	const geometry = new THREE.PlaneGeometry( patchSize, patchSize, 72, 72 );
	geometry.rotateX( - Math.PI / 2 );

	const material = new THREE.MeshBasicNodeMaterial();
	material.name = '地吹雪';
	material.transparent = true;
	material.depthWrite = false;

	// 跟着人走（中心按 2 米网格吸附，噪声是世界坐标，不会跟着滑）；贴着地形起伏
	const worldXZ = positionLocal.xz.add( uniforms.bandCenter );
	const ground = texture( state.heightTexture, terrainUV( worldXZ ) ).level( 0 ).r;
	material.positionNode = vec3( worldXZ.x, ground.add( layerHeight ), worldXZ.y );

	const windAngle = auroraConfig.windDirection * Math.PI / 180;
	const fragmentXZ = positionWorld.xz;
	const windAlong = fragmentXZ.x.mul( Math.cos( windAngle ) ).add( fragmentXZ.y.mul( Math.sin( windAngle ) ) );
	const windAcross = fragmentXZ.x.mul( - Math.sin( windAngle ) ).add( fragmentXZ.y.mul( Math.cos( windAngle ) ) );
	const time = uniforms.sceneTime;
	// 沿风向快速平移的拉伸 fbm 当密度；越高的层越淡（1.2 米以上消失）
	// 横向频率高、阈值窄：一缕一缕的细流，而不是大片的光带
	const flow = vec2( windAlong.mul( 0.6 ).sub( time.mul( auroraConfig.windSpeed * 0.6 ) ), windAcross.mul( 3.5 ) ).add( layerIndex * 17 );
	// fbm 大多落在 0.35~0.65，阈值要卡在这个范围里才有成条的卷流
	const streak = smoothstep( 0.52, 0.64, fbm2D( flow, 4 ) );
	const gust = smoothstep( 0.42, 0.6, fbm2D( fragmentXZ.div( 28 ).sub( vec2( time.mul( 0.08 ), 0 ) ), 2 ) );
	const heightFade = float( 1 ).sub( smoothstep( 0.1, 1.2, float( layerHeight ) ) );
	const fromCenter = length( fragmentXZ.sub( uniforms.bandCenter ) );
	// 远处卷流叠在一起就成了大片光带，30 米外就淡掉
	const edgeFade = float( 1 ).sub( smoothstep( 14, 32, fromCenter ) );
	const viewVector = cameraPosition.sub( positionWorld );
	const nearFade = smoothstep( 3.0, 10.0, length( viewVector ) );
	const viewDirection = normalize( viewVector );
	// 朝月亮看时卷流被照亮（前向散射）
	const backLight = pow( max( dot( viewDirection, uniforms.moonDirection.negate() ), 0 ), 4 );
	material.colorNode = uniforms.moonColor.mul( float( 0.2 ).add( backLight.mul( 1.2 ) ) ).add( uniforms.auroraLightColor.mul( 0.5 ) ).add( vec3( 0.06, 0.08, 0.13 ) );
	material.opacityNode = streak.mul( gust.mul( 0.7 ).add( 0.3 ) ).mul( heightFade ).mul( edgeFade ).mul( nearFade ).mul( 0.32 );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = '地吹雪';
	mesh.frustumCulled = false;
	mesh.renderOrder = 2;
	state.disposables.push( geometry, material );
	return mesh;

}

// 贴地被风卷起的亮粒
function createDriftSparks( count ) {

	const uniforms = state.uniforms;
	const auroraConfig = state.ctx.config.aurora;
	const material = new THREE.SpriteNodeMaterial();
	material.name = '地吹雪亮粒';
	material.transparent = true;
	material.depthWrite = false;

	const index = instanceIndex.toFloat();
	const seed = hash33( vec3( index, 77, 1 ) );
	const seedB = hash33( vec3( index, 77, 2 ) );
	const windAngle = auroraConfig.windDirection * Math.PI / 180;
	const box = float( 30 );
	const travel = uniforms.sceneTime.mul( auroraConfig.windSpeed * 1.3 ).mul( mix( 0.7, 1.3, seedB.x ) );
	const flat = seed.xz.mul( box ).add( vec2( Math.cos( windAngle ), Math.sin( windAngle ) ).mul( travel ) );
	const relative = flat.sub( cameraPosition.xz ).add( box.mul( 0.5 ) );
	const wrappedXZ = relative.sub( box.mul( floor( relative.div( box ) ) ) ).sub( box.mul( 0.5 ) ).add( cameraPosition.xz );
	const ground = texture( state.heightTexture, terrainUV( wrappedXZ ) ).level( 0 ).r;
	// 贴地跳动：高度 0~0.5 米，随时间小幅弹跳
	const hop = abs( sin( uniforms.sceneTime.mul( mix( 2, 5, seedB.y ) ).add( seed.y.mul( 20 ) ) ) ).mul( 0.25 ).add( seed.y.mul( 0.25 ) );
	material.positionNode = vec3( wrappedXZ.x, ground.add( hop ).add( 0.03 ), wrappedXZ.y );
	material.scaleNode = vec2( 0.012 );

	const centered = uv().sub( 0.5 ).mul( 2 );
	const twinkle = pow( abs( sin( uniforms.sceneTime.mul( mix( 3, 9, seedB.z ) ).add( seed.x.mul( 50 ) ) ) ), 6 );
	material.colorNode = uniforms.moonColor.mul( twinkle.mul( 3 ).add( 0.2 ) );
	material.opacityNode = float( 1 ).sub( smoothstep( 0, 1, length( centered ) ) ).mul( 0.9 );

	const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), material );
	mesh.name = '地吹雪亮粒';
	mesh.count = count;
	mesh.frustumCulled = false;
	state.disposables.push( mesh.geometry, material );
	return mesh;

}

// ===================== 生命周期 =====================

function moonDirectionFromConfig( auroraConfig ) {

	const azimuth = THREE.MathUtils.degToRad( auroraConfig.moonAzimuth );
	const elevation = THREE.MathUtils.degToRad( auroraConfig.moonElevation );
	return new THREE.Vector3( Math.sin( azimuth ) * Math.cos( elevation ), Math.sin( elevation ), - Math.cos( azimuth ) * Math.cos( elevation ) ).normalize();

}

function tierOf( ctx ) {

	return ctx.quality && ctx.quality.tier ? ctx.quality.tier : 'mid';

}

export async function init( ctx ) {

	if ( state.scene || state.disposables.length > 0 ) {

		console.warn( '雪原场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	try {

		return await buildScene( ctx );

	} catch ( error ) {

		// 建到一半失败：已经建好的渲染目标、贴图、几何体都要放掉，不能等下次 init 丢引用
		releaseResources();
		state.scene = null;
		state.ready = false;
		state.ctx = null;
		throw error;

	}

}

async function buildScene( ctx ) {

	const started = performance.now();
	state.ctx = ctx;
	state.disposables = [];
	state.readbackPending = false;
	const auroraConfig = ctx.config.aurora;
	const tier = tierOf( ctx );
	state.currentTier = tier;
	const params = ctx.quality.params;

	state.terrainSize = auroraConfig.terrainSize;
	state.terrainCenterZ = auroraConfig.terrainCenterZ;

	// ---------- uniforms ----------
	const moonDirection = moonDirectionFromConfig( auroraConfig );
	const moonColor = new THREE.Color( auroraConfig.moonColor ).multiplyScalar( auroraConfig.moonIntensity );
	state.uniforms = {
		sceneTime: uniform( 0 ),
		frameIndex: uniform( 0 ),
		moonDirection: uniform( moonDirection.clone() ),
		moonColor: uniform( moonColor.clone() ),
		moonBaseColor: uniform( new THREE.Color( auroraConfig.moonColor ) ),
		auroraLightColor: uniform( new THREE.Color( 0, 0, 0 ) ),
		auroraSteps: uniform( params.volumeSteps, 'int' ),
		auroraResolution: uniform( new THREE.Vector2( 16, 8 ) ),
		auroraBlend: uniform( 1 ),
		auroraBrightness: uniform( auroraConfig.auroraBrightness ),
		sparkleLayerCount: uniform( params.sparkleLayers ),
		pomSteps: uniform( auroraConfig.pomSteps[ tier ], 'int' ),
		wrapAmount: uniform( auroraConfig.wrapAmount ),
		revealDistance: uniform( auroraConfig.footprintRevealLead ),
		revealEnabled: uniform( ctx.config.footprintsReveal ? 1 : 0 ),
		bandCenter: uniform( new THREE.Vector2() ),
		fogAmount: uniform( 1 ),
		// 每层效果一个开关（1 开 0 关），调试面板逐个关闭看作用
		wrapToggle: uniform( 1 ),
		blueShadowToggle: uniform( 1 ),
		windToggle: uniform( 1 ),
		grainToggle: uniform( 1 ),
		mottleToggle: uniform( 1 ),
		sheenToggle: uniform( 1 ),
		forwardToggle: uniform( 1 ),
		ridgeToggle: uniform( 1 ),
		sparkleToggle: uniform( 1 ),
		footprintToggle: uniform( 1 ),
		auroraToggle: uniform( 1 ),
		auroraLightToggle: uniform( 1 ),
		atlasNode: null,
	};
	const uniforms = state.uniforms;

	// ---------- 岩石位置（先定，高度场要在它们脚下堆雪）----------
	state.rockSpots = [
		{ x: pathX( pathEndZ ) - 3.2, z: pathEndZ - 2.5, size: 1.6, seed: 1.3 },
		{ x: pathX( pathEndZ ) + 2.6, z: pathEndZ - 1.0, size: 1.1, seed: 4.7 },
		{ x: pathX( pathEndZ ) + 4.4, z: pathEndZ - 7.5, size: 2.0, seed: 2.2 },
		{ x: pathX( pathEndZ ) - 6.0, z: pathEndZ - 8.0, size: 1.3, seed: 6.1 },
		{ x: pathX( pathEndZ ) - 1.2, z: pathEndZ - 10.5, size: 0.8, seed: 8.8 },
		// 路上零星的几块
		{ x: pathX( - 150 ) + 14, z: - 150, size: 1.2, seed: 3.9 },
		{ x: pathX( - 260 ) - 18, z: - 262, size: 1.7, seed: 5.5 },
	];

	// ---------- 高度场 ----------
	const heightResolution = 512;
	const { heights, heightTexture } = buildHeightField( heightResolution, state.terrainSize, state.terrainCenterZ, state.rockSpots );
	state.heightData = heights;
	state.heightResolution = heightResolution;
	state.heightTexture = heightTexture;
	state.disposables.push( heightTexture );

	const atlas = buildFootprintAtlas();
	state.disposables.push( atlas );
	uniforms.atlasNode = texture( atlas );

	// ---------- 场景 ----------
	const scene = new THREE.Scene();
	scene.background = new THREE.Color( auroraConfig.skyHorizon );

	// 极光半球贴图要在天空材质之前建（天空要采样它）
	state.auroraPass = createAuroraPass( ctx.renderer );
	applyQualityResolution( params );

	const terrainGeometry = buildTerrainGeometry( auroraConfig.terrainSegments[ tier ], state.terrainSize, state.terrainCenterZ );
	const snowMaterial = createSnowMaterial( tier );
	const terrain = new THREE.Mesh( terrainGeometry, snowMaterial );
	terrain.name = '雪地';
	terrain.receiveShadow = true;
	terrain.castShadow = true;
	// 地形只用背光面写阴影深度：雪丘照样能挡光，受光面不会自己挡自己出条纹
	snowMaterial.shadowSide = THREE.BackSide;
	scene.add( terrain );
	state.disposables.push( terrainGeometry, snowMaterial );

	scene.add( createOuterSnow( snowMaterial ) );

	state.skyDome = createSkyDome();
	scene.add( state.skyDome );
	scene.add( createDistantMountains() );
	scene.add( createRocks() );

	const treeX = pathX( treeZ ) + 0.6;
	state.treePosition.set( treeX, heightAt( treeX, treeZ ), treeZ );
	scene.add( createDeadTree( state.treePosition ) );

	// ---------- 灯光 ----------
	const moonLight = new THREE.DirectionalLight( new THREE.Color( auroraConfig.moonColor ), auroraConfig.moonIntensity );
	moonLight.name = '月光';
	const shadowSize = params.shadowSize;
	if ( shadowSize > 0 ) {

		moonLight.castShadow = true;
		moonLight.shadow.mapSize.set( shadowSize, shadowSize );
		const shadowCamera = moonLight.shadow.camera;
		shadowCamera.left = - 70;
		shadowCamera.right = 70;
		shadowCamera.top = 70;
		shadowCamera.bottom = - 70;
		shadowCamera.near = 1;
		shadowCamera.far = 400;
		shadowCamera.updateProjectionMatrix();
		// 月亮只有 15°，光线几乎贴着雪面：偏移给大一点，否则平地上全是长条状的自阴影瑕疵
		moonLight.shadow.bias = - 0.0008;
		moonLight.shadow.normalBias = 0.25;
		// PCF 采样半径放大，雪丘投下的影子边缘软一点（形要软）
		moonLight.shadow.radius = 6;

	}

	scene.add( moonLight );
	scene.add( moonLight.target );
	state.moonLight = moonLight;

	// 阴影区的环境光：天空半球色（深蓝 + 一点极光绿），不能是灰色
	const hemisphereLight = new THREE.HemisphereLight( new THREE.Color( auroraConfig.shadowSkyColor ), new THREE.Color( auroraConfig.groundBounceColor ), auroraConfig.ambientIntensity );
	hemisphereLight.name = '天空光';
	scene.add( hemisphereLight );
	state.hemisphereLight = hemisphereLight;

	// ---------- 粒子 ----------
	const snowTotal = auroraConfig.snowCount[ tier ];
	state.snowNear = createFallingSnow( { count: Math.round( snowTotal * 0.3 ), boxSize: 16, size: 0.014, stretch: 2.4, seedOffset: 1, brightness: 1.3 } );
	state.snowFar = createFallingSnow( { count: Math.round( snowTotal * 0.7 ), boxSize: 40, size: 0.02, stretch: 1.0, seedOffset: 2, brightness: 0.7 } );
	scene.add( state.snowNear, state.snowFar );

	state.bands = [ 0.08, 0.22, 0.5 ].map( ( height, index ) => createBlowingBand( height, index ) );
	for ( const band of state.bands ) scene.add( band );
	state.driftSparks = createDriftSparks( 700 );
	scene.add( state.driftSparks );

	// ---------- 高度雾 ----------
	scene.fogNode = heightFog( {
		density: uniform( auroraConfig.fogDensity ),
		falloff: uniform( auroraConfig.fogFalloff ),
		baseColor: color( auroraConfig.fogColor ).add( uniforms.auroraLightColor.mul( 0.15 ) ),
		scatterColor: color( auroraConfig.fogScatterColor ),
		lightDirection: uniforms.moonDirection,
		anisotropy: float( 0.6 ),
		amount: uniforms.fogAmount,
	} );

	// ---------- 调试开关 ----------
	const setVisible = ( list ) => ( visible ) => {

		for ( const object of list ) object.visible = visible;

	};
	state.layers = {
		柔和明暗: uniforms.wrapToggle,
		蓝色阴影: ( enabled ) => {

			uniforms.blueShadowToggle.value = enabled ? 1 : 0;
			applyAuroraLight();

		},
		风纹: uniforms.windToggle,
		颗粒: uniforms.grainToggle,
		斑驳: uniforms.mottleToggle,
		绒光: uniforms.sheenToggle,
		前向散射: uniforms.forwardToggle,
		棱线透光: uniforms.ridgeToggle,
		闪光: uniforms.sparkleToggle,
		脚印: uniforms.footprintToggle,
		地吹雪: setVisible( [ ...state.bands, state.driftSparks ] ),
		飘雪: setVisible( [ state.snowNear, state.snowFar ] ),
		高度雾: uniforms.fogAmount,
		极光: uniforms.auroraToggle,
		极光照明: ( enabled ) => {

			uniforms.auroraLightToggle.value = enabled ? 1 : 0;
			applyAuroraLight();

		},
	};

	state.scene = scene;
	state.ready = true;
	state.frameIndex = 0;
	state.revealDistance = auroraConfig.footprintRevealLead;
	state.auroraAverageColor.setRGB( 0.02, 0.06, 0.04 );
	state.auroraColors = {
		light: new THREE.Color(),
		shadowSky: new THREE.Color( auroraConfig.shadowSkyColor ),
		groundBounce: new THREE.Color( auroraConfig.groundBounceColor ),
		graySky: new THREE.Color( '#2b2b2f' ),
		grayGround: new THREE.Color( '#3a3a3e' ),
	};

	// 先画一帧极光贴图，顺便把这两个全屏着色器编译掉
	state.auroraPass.render( 1 );

	console.log( `雪原场景：初始化完成，用时 ${ ( performance.now() - started ).toFixed( 0 ) } ms，档位 ${ tier }` );
	return { scene };

}

function applyQualityResolution( params ) {

	// 极光贴图：高档全分辨率（2048 宽，约 0.18° 一个像素），中低档半分辨率
	const width = params.volumeFullRes ? 2048 : 1024;
	const height = params.volumeFullRes ? 640 : 320;
	state.auroraPass.setResolution( width, height );

}

function playerStart() {

	const z = 2;
	const x = pathX( z ) + 1.5;
	const ground = heightAt( x, z );
	const eyeHeight = state.ctx.config.camera.eyeHeight;
	// 视线略微抬头：地平线落在画面下三分之一，极光占上半
	const lookZ = - 60;
	const lookX = pathX( lookZ );
	return { position: [ x, ground + eyeHeight, z ], lookAt: [ lookX, ground + eyeHeight + 9, lookZ ] };

}

export function enter() {

	if ( ! state.ready ) throw new Error( '雪原场景：还没 init 就调了 enter' );

	const ctx = state.ctx;
	const start = playerStart();
	const size = state.terrainSize;
	// 地形外圈 80 米已经平滑落到 0，外面还有一圈平雪，留 60 米够用
	const margin = 60;
	const obstacles = state.rockSpots.map( ( spot ) => ( { x: spot.x, z: spot.z, radius: spot.size * 1.15 + 0.3 } ) );
	obstacles.push( { x: state.treePosition.x, z: state.treePosition.z, radius: 0.7 } );
	ctx.director.setWalk( {
		position: start.position,
		lookAt: start.lookAt,
		groundHeight: heightAt,
		obstacles,
		bounds: {
			minX: - size / 2 + margin,
			maxX: size / 2 - margin,
			minZ: state.terrainCenterZ - size / 2 + margin,
			maxZ: state.terrainCenterZ + size / 2 - margin,
		},
	} );

	for ( const label of Object.keys( state.layers ) ) {

		ctx.debug.addLayerToggle( key, label, state.layers[ label ] );

	}

}

export function update( dt, time ) {

	if ( ! state.ready ) return;

	const ctx = state.ctx;
	const uniforms = state.uniforms;
	const auroraConfig = ctx.config.aurora;
	const camera = ctx.camera;
	state.frameIndex ++;

	uniforms.sceneTime.value = time;
	uniforms.frameIndex.value = state.frameIndex % 1024;

	// ---------- 画质：每帧看一眼当前档位的参数（动态降档时跟着变）----------
	const params = ctx.quality.params;
	const tier = tierOf( ctx );
	uniforms.auroraSteps.value = params.volumeSteps;
	uniforms.sparkleLayerCount.value = params.sparkleLayers;
	uniforms.pomSteps.value = auroraConfig.pomSteps[ tier ];
	applyQualityResolution( params );
	if ( tier !== state.currentTier ) {

		state.currentTier = tier;
		const snowTotal = auroraConfig.snowCount[ tier ];
		state.snowNear.count = Math.round( snowTotal * 0.3 );
		state.snowFar.count = Math.round( snowTotal * 0.7 );

	}

	// ---------- 天空球、阴影相机跟着人 ----------
	state.skyDome.position.copy( camera.position );
	const moonDirection = uniforms.moonDirection.value;
	state.moonLight.target.position.set( camera.position.x, camera.position.y - 1.6, camera.position.z );
	state.moonLight.position.copy( state.moonLight.target.position ).addScaledVector( moonDirection, 200 );
	state.moonLight.target.updateMatrixWorld();

	// 地吹雪的面片中心按 2 米网格吸附
	uniforms.bandCenter.value.set( Math.round( camera.position.x / 2 ) * 2, Math.round( camera.position.z / 2 ) * 2 );

	// ---------- 脚印揭示：人往前走，前方 lead 米以内的脚印出现，只增不减 ----------
	const along = - camera.position.z;
	const lateral = Math.abs( camera.position.x - pathX( camera.position.z ) );
	if ( lateral < 20 ) state.revealDistance = Math.max( state.revealDistance, along + auroraConfig.footprintRevealLead );
	uniforms.revealDistance.value = state.revealDistance;

	// ---------- 极光贴图：低档每 2 帧更新一次 ----------
	const updateEvery = tier === 'lo' ? 2 : 1;
	if ( state.frameIndex % updateEvery === 0 ) {

		const blend = state.frameIndex < 4 ? 1 : 0.1;
		state.auroraPass.render( blend );

	}

	// ---------- 极光平均色 → 半球光 + 闪光颜色 ----------
	if ( state.frameIndex % 6 === 0 ) requestAverageReadback( ctx.renderer );
	applyAuroraLight();

}

// 极光平均色、两个开关 → 半球光颜色和"极光光照"uniform。开关一拨就立刻生效（暂停时也一样）
function applyAuroraLight() {

	const auroraConfig = state.ctx.config.aurora;
	const uniforms = state.uniforms;
	// 半球平均色本身很小（绿约 0.015，大半个天是黑的）；乘 60 × strength 后绿约 0.15，即半球光强度 0.05~0.2 那一档
	const colors = state.auroraColors;
	const auroraLight = colors.light.copy( state.auroraAverageColor ).multiplyScalar( auroraConfig.auroraLightStrength * 60 * uniforms.auroraLightToggle.value );
	uniforms.auroraLightColor.value.copy( auroraLight );

	const blueShadow = uniforms.blueShadowToggle.value > 0.5;
	// 关掉"蓝色阴影"时，阴影里的环境光换成同样亮度的灰色，对比蓝影的作用
	state.hemisphereLight.color.copy( blueShadow ? colors.shadowSky : colors.graySky ).add( auroraLight );
	state.hemisphereLight.groundColor.copy( blueShadow ? colors.groundBounce : colors.grayGround );

}

export function exit() {

	if ( ! state.ctx ) return;
	state.ctx.debug.removeSceneToggles( key );
	// 场景释放后 heightAt 就没数据了，镜头不能再拿它贴地
	state.ctx.director.clearWalk();

}

// 释放所有登记过的几何体、材质、贴图、渲染目标（建到一半失败时也调它）
function releaseResources() {

	for ( const item of state.disposables ) {

		if ( item && typeof item.dispose === 'function' ) item.dispose();

	}

	state.disposables = [];
	if ( state.moonLight && state.moonLight.shadow ) state.moonLight.shadow.dispose();

}

export function dispose() {

	if ( ! state.scene && state.disposables.length === 0 ) return;
	state.ready = false;

	releaseResources();

	if ( state.scene ) {

		state.scene.fogNode = null;
		state.scene.clear();
		state.scene.background = null;

	}

	state.scene = null;
	state.heightData = null;
	state.heightTexture = null;
	state.uniforms = null;
	state.layers = null;
	state.moonLight = null;
	state.hemisphereLight = null;
	state.skyDome = null;
	state.bands = [];
	state.snowNear = null;
	state.snowFar = null;
	state.driftSparks = null;
	state.auroraPass = null;
	state.auroraColors = null;
	state.ctx = null;
	console.log( '雪原场景：已释放' );

}

// ===================== 截图和调试用 =====================

// 规格书 7.11 的三张验收画面 + 枯树下抬头
export function getShotViews() {

	if ( ! state.ready ) return [];
	const eyeHeight = state.ctx.config.camera.eyeHeight;
	const ground = ( x, z ) => heightAt( x, z );
	const moonDirection = state.uniforms.moonDirection.value;

	const start = playerStart();

	const nearZ = - 22;
	const nearX = pathX( nearZ ) + 0.75;
	const footZ = nearZ - 2.2;
	const footX = pathX( footZ );

	const backZ = - 120;
	const backX = pathX( backZ ) + 25;
	const backGround = ground( backX, backZ );

	// 站在枯树前十几米，枯树剪影压在极光下缘上
	const treeLookZ = treeZ + 16;
	const treeLookX = pathX( treeLookZ ) - 2.5;

	return [
		{ name: '远景', position: start.position, lookAt: start.lookAt },
		{ name: '近景低头', position: [ nearX, ground( nearX, nearZ ) + eyeHeight, nearZ ], lookAt: [ footX, ground( footX, footZ ), footZ ] },
		{ name: '逆光', position: [ backX, backGround + eyeHeight, backZ ], lookAt: [ backX + moonDirection.x * 50, backGround + 1.5, backZ + moonDirection.z * 50 ] },
		{ name: '枯树抬头', position: [ treeLookX, ground( treeLookX, treeLookZ ) + eyeHeight, treeLookZ ], lookAt: [ state.treePosition.x, state.treePosition.y + 8, state.treePosition.z ] },
	];

}

export function getLayers() {

	return state.layers || {};

}
