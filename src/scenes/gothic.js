// 场景 3：入夜哥特城堡（阶段 0 简版：深蓝天空 + 湖面 + 几座尖塔和暖黄窗灯）
// 配色来自规格书第 11 节。真场景在阶段 5 做，这里只跑通流程。

import * as THREE from 'three/webgpu';
import { uniform, color } from 'three/tsl';

export const key = 'gothic';

const palette = {
	sky: '#1d2c5c',        // 天空亮处
	skyDark: '#0b1636',    // 天空暗处
	lake: '#0a1226',       // 湖面
	castle: '#141a2e',     // 城堡剪影
	window: '#ffb35c',     // 窗灯
	moon: '#b8c8f0',       // 月光
};

const groundSize = 400;
const glowStrengthBase = 5;

const state = {
	ctx: null,
	scene: null,
	ready: false,
	glowToggle: null,
	groundToggle: null,
	glowStrength: null,
	windows: [],
	moon: null,
};

function makeMaterial( baseColor, glowColor ) {

	const material = new THREE.MeshStandardNodeMaterial();
	material.roughness = 0.7;
	material.metalness = 0;
	material.colorNode = color( baseColor );
	if ( glowColor ) {

		material.emissiveNode = color( glowColor ).mul( state.glowStrength ).mul( state.glowToggle );

	}

	return material;

}

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '城堡场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	state.ctx = ctx;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( palette.sky );

	state.glowToggle = uniform( 1 );
	state.groundToggle = uniform( 1 );
	state.glowStrength = uniform( glowStrengthBase );

	const shadowSize = ctx.quality?.params?.shadowSize ?? 0;

	// 湖面
	const lakeMaterial = new THREE.MeshStandardNodeMaterial();
	lakeMaterial.roughness = 0.2;
	lakeMaterial.metalness = 0.2;
	lakeMaterial.colorNode = color( palette.lake ).mul( state.groundToggle );
	const lake = new THREE.Mesh( new THREE.PlaneGeometry( groundSize, groundSize ), lakeMaterial );
	lake.rotation.x = - Math.PI / 2;
	lake.receiveShadow = shadowSize > 0;
	scene.add( lake );

	// 城堡：对岸一排高低不一的圆塔 + 圆锥尖顶
	const castleMaterial = makeMaterial( palette.castle, null );
	const towerHeights = [ 14, 22, 18, 26, 16 ];
	const towerGeometry = new THREE.CylinderGeometry( 1.6, 2.0, 1, 12 );
	const roofGeometry = new THREE.ConeGeometry( 2.0, 5, 12 );
	for ( let i = 0; i < towerHeights.length; i ++ ) {

		const height = towerHeights[ i ];
		const x = ( i - 2 ) * 6;
		const tower = new THREE.Mesh( towerGeometry, castleMaterial );
		tower.scale.y = height;
		tower.position.set( x, height / 2, - 60 );
		tower.castShadow = shadowSize > 0;
		scene.add( tower );

		const roof = new THREE.Mesh( roofGeometry, castleMaterial );
		roof.position.set( x, height + 2.5, - 60 );
		scene.add( roof );

	}

	// 窗灯：贴在塔身上的小发光方块，亮起时间按高度错开（update 里控制）
	const windowGeometry = new THREE.BoxGeometry( 0.5, 0.8, 0.2 );
	state.windows = [];
	for ( let i = 0; i < towerHeights.length; i ++ ) {

		const floors = Math.floor( towerHeights[ i ] / 3 );
		for ( let j = 1; j < floors; j ++ ) {

			const windowMaterial = makeMaterial( palette.window, palette.window );
			const windowMesh = new THREE.Mesh( windowGeometry, windowMaterial );
			windowMesh.position.set( ( i - 2 ) * 6, j * 3, - 58 );
			windowMesh.visible = false;
			scene.add( windowMesh );
			// 伪随机延迟：高楼层更晚亮，同层再加一点散布
			const delay = j * 1.6 + ( ( i * 7 + j * 13 ) % 10 ) * 0.5;
			state.windows.push( { mesh: windowMesh, delay } );

		}

	}

	// 月亮：画面一侧偏低的淡蓝发光球
	const moon = new THREE.Mesh( new THREE.SphereGeometry( 3, 24, 12 ), makeMaterial( palette.moon, palette.moon ) );
	moon.position.set( 40, 30, - 160 );
	scene.add( moon );
	state.moon = moon;

	// 冷月光 + 深蓝半球光
	const moonLight = new THREE.DirectionalLight( palette.moon, 1.2 );
	moonLight.position.set( 40, 40, - 60 );
	if ( shadowSize > 0 ) {

		moonLight.castShadow = true;
		moonLight.shadow.mapSize.set( shadowSize, shadowSize );
		moonLight.shadow.camera.left = - 60;
		moonLight.shadow.camera.right = 60;
		moonLight.shadow.camera.top = 60;
		moonLight.shadow.camera.bottom = - 60;
		moonLight.shadow.camera.near = 1;
		moonLight.shadow.camera.far = 250;
		moonLight.shadow.camera.updateProjectionMatrix();

	}

	scene.add( moonLight );
	scene.add( new THREE.HemisphereLight( palette.sky, palette.lake, 0.5 ) );

	state.scene = scene;
	state.ready = true;
	return { scene };

}

export function enter() {

	if ( ! state.ready ) throw new Error( '城堡场景：还没 init 就调了 enter' );

	const ctx = state.ctx;
	const sceneConfig = ctx.config.scenes.find( ( item ) => item.key === key );
	if ( ! sceneConfig ) throw new Error( `城堡场景：config.scenes 里找不到 key 为 ${ key } 的条目` );
	const duration = sceneConfig.duration;

	// 从湖对岸低机位慢慢推近，但不靠太近
	ctx.director.setRoute( [
		{ time: 0, position: [ 0, 1.5, 30 ], lookAt: [ 0, 12, - 60 ] },
		{ time: duration * 0.6, position: [ 4, 2.5, 10 ], lookAt: [ 0, 14, - 60 ] },
		{ time: duration, position: [ - 3, 3, - 5 ], lookAt: [ 0, 16, - 60 ] },
	] );

	ctx.debug.addLayerToggle( key, '发光体', state.glowToggle );
	ctx.debug.addLayerToggle( key, '地面', state.groundToggle );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;

	// 窗户按各自延迟一扇扇亮起
	for ( const item of state.windows ) {

		item.mesh.visible = time >= item.delay;

	}

	state.moon.position.y = 30 + Math.sin( time * 0.05 ) * 1.5;

}

export function exit() {

	if ( ! state.ctx ) return;
	state.ctx.debug.removeSceneToggles( key );

}

function disposeMaterial( material, seen ) {

	if ( ! material || seen.has( material ) ) return;
	seen.add( material );
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
	state.windows = [];
	state.moon = null;
	state.glowToggle = null;
	state.groundToggle = null;
	state.glowStrength = null;
	state.ctx = null;
	console.log( '城堡场景：已释放' );

}
