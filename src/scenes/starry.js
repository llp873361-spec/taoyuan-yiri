// 场景 4：深夜梵高星月夜（阶段 0 简版：群青天空 + 暗紫山丘 + 几颗发光的星和月、一棵柏树剪影）
// 配色来自规格书第 9 节。真场景在阶段 3 做，这里只跑通流程。

import * as THREE from 'three/webgpu';
import { uniform, color } from 'three/tsl';

export const key = 'starry';

const palette = {
	sky: '#1b3a8c',        // 群青
	cobalt: '#2c5aa0',     // 钴蓝
	azure: '#6fa3d6',      // 天蓝
	yellow: '#f2c94c',     // 铬黄
	lemon: '#f7e27a',      // 柠檬黄
	moon: '#fff6d6',       // 月白
	cypress: '#1d2e1f',    // 柏树墨绿
	hill: '#24304f',       // 山的暗紫蓝
};

const groundSize = 400;
const glowStrengthBase = 7;

const state = {
	ctx: null,
	scene: null,
	ready: false,
	glowToggle: null,
	groundToggle: null,
	glowStrength: null,
	stars: [],
	moon: null,
};

function makeMaterial( baseColor, glowColor ) {

	const material = new THREE.MeshStandardNodeMaterial();
	material.roughness = 0.8;
	material.metalness = 0;
	material.colorNode = color( baseColor );
	if ( glowColor ) {

		material.emissiveNode = color( glowColor ).mul( state.glowStrength ).mul( state.glowToggle );

	}

	return material;

}

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '星空场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	state.ctx = ctx;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( palette.sky );

	state.glowToggle = uniform( 1 );
	state.groundToggle = uniform( 1 );
	state.glowStrength = uniform( glowStrengthBase );

	const shadowSize = ctx.quality?.params?.shadowSize ?? 0;

	// 山丘：地面 + 几个压扁的半球
	const groundMaterial = new THREE.MeshStandardNodeMaterial();
	groundMaterial.roughness = 0.9;
	groundMaterial.colorNode = color( palette.hill ).mul( state.groundToggle );
	const ground = new THREE.Mesh( new THREE.PlaneGeometry( groundSize, groundSize ), groundMaterial );
	ground.rotation.x = - Math.PI / 2;
	ground.receiveShadow = shadowSize > 0;
	scene.add( ground );

	const hillGeometry = new THREE.SphereGeometry( 1, 24, 12 );
	const hillMaterial = makeMaterial( palette.hill, null );
	const hills = [ [ - 30, - 70, 18, 9 ], [ 10, - 90, 26, 12 ], [ 45, - 75, 20, 8 ] ];
	for ( let i = 0; i < hills.length; i ++ ) {

		const hill = new THREE.Mesh( hillGeometry, hillMaterial );
		hill.position.set( hills[ i ][ 0 ], 0, hills[ i ][ 1 ] );
		hill.scale.set( hills[ i ][ 2 ], hills[ i ][ 3 ], hills[ i ][ 2 ] );
		scene.add( hill );

	}

	// 柏树：画面左侧一座火焰形的高圆锥剪影
	const cypress = new THREE.Mesh( new THREE.ConeGeometry( 2.2, 20, 10 ), makeMaterial( palette.cypress, null ) );
	cypress.position.set( - 9, 10, - 12 );
	cypress.castShadow = shadowSize > 0;
	scene.add( cypress );

	// 星：几颗黄色发光球散在天上，update 里轻微呼吸
	const starGeometry = new THREE.SphereGeometry( 1.2, 16, 12 );
	state.stars = [];
	const starSpots = [ [ - 25, 32, - 100 ], [ - 5, 40, - 110 ], [ 18, 35, - 105 ], [ 32, 26, - 95 ], [ 6, 24, - 90 ] ];
	for ( let i = 0; i < starSpots.length; i ++ ) {

		const starColor = i % 2 === 0 ? palette.yellow : palette.lemon;
		const star = new THREE.Mesh( starGeometry, makeMaterial( starColor, starColor ) );
		star.position.fromArray( starSpots[ i ] );
		scene.add( star );
		state.stars.push( { mesh: star, phase: i * 1.3 } );

	}

	// 月：右上角一轮月白发光球
	const moon = new THREE.Mesh( new THREE.SphereGeometry( 3.5, 24, 12 ), makeMaterial( palette.moon, palette.moon ) );
	moon.position.set( 40, 42, - 120 );
	scene.add( moon );
	state.moon = moon;

	// 淡淡的月光 + 群青/暗紫半球光
	const moonLight = new THREE.DirectionalLight( palette.moon, 0.8 );
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
	scene.add( new THREE.HemisphereLight( palette.cobalt, palette.hill, 0.6 ) );

	state.scene = scene;
	state.ready = true;
	return { scene };

}

export function enter() {

	if ( ! state.ready ) throw new Error( '星空场景：还没 init 就调了 enter' );

	const ctx = state.ctx;
	const sceneConfig = ctx.config.scenes.find( ( item ) => item.key === key );
	if ( ! sceneConfig ) throw new Error( `星空场景：config.scenes 里找不到 key 为 ${ key } 的条目` );
	const duration = sceneConfig.duration;

	// 几乎不动，只非常缓慢地推近，最后抬向月亮
	ctx.director.setRoute( [
		{ time: 0, position: [ 0, 3, 20 ], lookAt: [ 0, 28, - 100 ] },
		{ time: duration * 0.8, position: [ 0.5, 3.2, 16 ], lookAt: [ 2, 30, - 100 ] },
		{ time: duration, position: [ 0.5, 3.4, 15 ], lookAt: [ 40, 42, - 120 ] },
	] );

	ctx.debug.addLayerToggle( key, '发光体', state.glowToggle );
	ctx.debug.addLayerToggle( key, '地面', state.groundToggle );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;

	// 星星轻微呼吸（缩放），月亮缓慢自转
	for ( const star of state.stars ) {

		const scale = 1 + Math.sin( time * 1.1 + star.phase ) * 0.15;
		star.mesh.scale.setScalar( scale );

	}

	state.moon.rotation.y = time * 0.05;

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
	state.stars = [];
	state.moon = null;
	state.glowToggle = null;
	state.groundToggle = null;
	state.glowStrength = null;
	state.ctx = null;
	console.log( '星空场景：已释放' );

}
