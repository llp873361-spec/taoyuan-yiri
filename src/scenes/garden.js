// 场景 1:清晨白银花园城堡(阶段 0 简版:纯色天空 + 地面 + 几个发光几何体)
// 配色来自规格书第 10 节。真场景在阶段 4 做,这里只跑通 init/enter/update/exit/dispose 的流程。

import * as THREE from 'three/webgpu';
import { uniform, color } from 'three/tsl';

export const key = 'garden';

// 场景配色(规格书 10.1)
const palette = {
	sky: '#f3e3df',        // 晨雾色,和天空低处 #ffd9c2 调和后的主色
	ground: '#7f9c63',     // 草地
	marble: '#f4f1ec',     // 大理石
	silver: '#e6ecf4',     // 银穹顶
	cypress: '#2f4a2a',    // 柏树深绿(配色表里没有,取草地的暗一档)
	flower: '#f5c6d6',     // 淡粉花
	flowerLilac: '#d9c8f0',// 淡紫花
	sunLight: '#ffd9c2',   // 晨光
	skyHigh: '#bcd3ee',    // 天空高处,给半球光
};

const groundSize = 400;
const glowStrengthBase = 4;   // 发光体 HDR 强度,3~8 之间,验证 bloom 用

// 模块内状态。所有 three 对象都在 init 里建,dispose 后能重新 init
const state = {
	ctx: null,
	scene: null,
	ready: false,
	glowToggle: null,       // 层开关:发光体
	groundToggle: null,     // 层开关:地面
	glowStrength: null,     // 发光强度 uniform
	dome: null,
	ring: null,
	petals: [],             // 浮动的花瓣小球,带各自的基准位置和相位
};

function makeMaterial( baseColor, glowColor ) {
	const material = new THREE.MeshStandardNodeMaterial();
	material.roughness = 0.55;
	material.metalness = 0;
	material.colorNode = color( baseColor );
	if ( glowColor ) {
		material.emissiveNode = color( glowColor ).mul( state.glowStrength ).mul( state.glowToggle );
	}
	return material;
}

export async function init( ctx ) {
	if ( state.scene ) {
		console.warn( '花园场景:init 被重复调用,先释放旧的再重建' );
		dispose();
	}
	state.ctx = ctx;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( palette.sky );

	state.glowToggle = uniform( 1 );
	state.groundToggle = uniform( 1 );
	state.glowStrength = uniform( glowStrengthBase );

	const shadowSize = ctx.quality?.params?.shadowSize ?? 0;

	// 地面:草地
	const groundMaterial = new THREE.MeshStandardNodeMaterial();
	groundMaterial.roughness = 0.9;
	groundMaterial.colorNode = color( palette.ground ).mul( state.groundToggle );
	const ground = new THREE.Mesh( new THREE.PlaneGeometry( groundSize, groundSize ), groundMaterial );
	ground.rotation.x = - Math.PI / 2;
	ground.receiveShadow = shadowSize > 0;
	scene.add( ground );

	// 穹顶:银色大球,远处正中,是镜头的目标
	const dome = new THREE.Mesh( new THREE.SphereGeometry( 3, 32, 16 ), makeMaterial( palette.marble, palette.silver ) );
	dome.position.set( 0, 3, - 12 );
	dome.castShadow = shadowSize > 0;
	scene.add( dome );
	state.dome = dome;

	// 两排柏树:细高圆锥,不发光
	const cypressGeometry = new THREE.ConeGeometry( 1.1, 6, 16 );
	const cypressMaterial = makeMaterial( palette.cypress, null );
	for ( let i = 0; i < 4; i ++ ) {
		const side = i % 2 === 0 ? - 1 : 1;
		const cypress = new THREE.Mesh( cypressGeometry, cypressMaterial );
		cypress.position.set( side * 6, 3, - 2 + Math.floor( i / 2 ) * 12 );
		cypress.castShadow = shadowSize > 0;
		scene.add( cypress );
	}

	// 花环:水池上方漂着的一圈淡粉发光环
	const ring = new THREE.Mesh( new THREE.TorusGeometry( 2.2, 0.25, 12, 48 ), makeMaterial( palette.flower, palette.flower ) );
	ring.position.set( 0, 1.2, 6 );
	ring.rotation.x = Math.PI / 2;
	scene.add( ring );
	state.ring = ring;

	// 花瓣:几颗淡紫小球,在中轴两侧缓慢上下浮
	const petalGeometry = new THREE.SphereGeometry( 0.3, 16, 12 );
	const petalMaterial = makeMaterial( palette.flowerLilac, palette.flowerLilac );
	state.petals = [];
	for ( let i = 0; i < 3; i ++ ) {
		const petal = new THREE.Mesh( petalGeometry, petalMaterial );
		const base = new THREE.Vector3( ( i - 1 ) * 3, 1.8, 14 - i * 2 );
		petal.position.copy( base );
		scene.add( petal );
		state.petals.push( { mesh: petal, base, phase: i * 2.1 } );
	}

	// 逆光的晨光 + 天色/草地色半球光
	const sun = new THREE.DirectionalLight( palette.sunLight, 2.0 );
	sun.position.set( - 20, 15, - 40 );
	if ( shadowSize > 0 ) {
		sun.castShadow = true;
		sun.shadow.mapSize.set( shadowSize, shadowSize );
		sun.shadow.camera.left = - 40;
		sun.shadow.camera.right = 40;
		sun.shadow.camera.top = 40;
		sun.shadow.camera.bottom = - 40;
		sun.shadow.camera.near = 1;
		sun.shadow.camera.far = 120;
		sun.shadow.camera.updateProjectionMatrix();
	}
	scene.add( sun );
	scene.add( new THREE.HemisphereLight( palette.skyHigh, palette.ground, 0.8 ) );

	state.scene = scene;
	state.ready = true;
	return { scene };
}

export function enter() {
	if ( ! state.ready ) {
		throw new Error( '花园场景:还没 init 就调了 enter' );
	}
	const ctx = state.ctx;
	const sceneConfig = ctx.config.scenes.find( ( item ) => item.key === key );
	if ( ! sceneConfig ) {
		throw new Error( `花园场景:config.scenes 里找不到 key 为 ${ key } 的条目` );
	}
	const duration = sceneConfig.duration;

	// 沿水池中轴线从远处缓慢推近穹顶,略微左右摆
	ctx.director.setRoute( [
		{ time: 0, position: [ 0, 1.6, 42 ], lookAt: [ 0, 3, - 12 ] },
		{ time: duration * 0.5, position: [ 1.5, 2.0, 24 ], lookAt: [ 0, 3, - 12 ] },
		{ time: duration, position: [ 0, 2.4, 8 ], lookAt: [ 0, 3.5, - 12 ] },
	] );

	ctx.debug.addLayerToggle( key, '发光体', state.glowToggle );
	ctx.debug.addLayerToggle( key, '地面', state.groundToggle );
}

export function update( dt, time ) {
	if ( ! state.ready ) return;

	// 穹顶自转,花环缓慢转圈,花瓣按各自相位上下浮(全部由 time 决定,可重放)
	state.dome.rotation.y = time * 0.15;
	state.ring.rotation.z = time * 0.2;
	for ( const petal of state.petals ) {
		petal.mesh.position.y = petal.base.y + Math.sin( time * 0.8 + petal.phase ) * 0.4;
		petal.mesh.position.x = petal.base.x + Math.sin( time * 0.3 + petal.phase ) * 0.6;
	}
}

export function exit() {
	if ( ! state.ctx ) return;
	state.ctx.debug.removeSceneToggles( key );
}

function disposeMaterial( material, seen ) {
	if ( ! material || seen.has( material ) ) return;
	seen.add( material );
	// 材质里挂的贴图不会随材质自动释放,逐个找出来 dispose(空场景没贴图,留着是为了以后不漏)
	for ( const value of Object.values( material ) ) {
		if ( value && value.isTexture ) value.dispose();
	}
	material.dispose();
}

export function dispose() {
	if ( ! state.scene ) return;
	state.ready = false;

	const meshes = [];
	const seenGeometries = new Set();
	const seenMaterials = new Set();
	state.scene.traverse( ( object ) => {
		if ( object.isMesh ) meshes.push( object );
		if ( object.isLight && object.shadow ) object.shadow.dispose();
	} );
	for ( const mesh of meshes ) {
		if ( mesh.geometry && ! seenGeometries.has( mesh.geometry ) ) {
			seenGeometries.add( mesh.geometry );
			mesh.geometry.dispose();
		}
		disposeMaterial( mesh.material, seenMaterials );
	}
	state.scene.clear();
	state.scene.background = null;

	state.scene = null;
	state.dome = null;
	state.ring = null;
	state.petals = [];
	state.glowToggle = null;
	state.groundToggle = null;
	state.glowStrength = null;
	state.ctx = null;
	console.log( '花园场景:已释放' );
}
