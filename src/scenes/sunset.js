// 场景 2：黄昏落日与海（阶段 0 简版：橙金天空 + 深蓝海面 + 发光的"太阳"和几块礁石）
// 配色来自规格书第 8 节。真场景在阶段 2 做，这里只跑通流程。

import * as THREE from 'three/webgpu';
import { uniform, color } from 'three/tsl';

export const key = 'sunset';

const palette = {
	sky: '#ff9a4d',       // 地平线橙金，作为天空主色
	sea: '#1d2b4a',       // 海水暗部
	sun: '#fff1c9',       // 太阳
	midSky: '#f27b8a',    // 中空粉
	highSky: '#8f6fbf',   // 高空紫
	rock: '#2a2420',      // 礁石
	foam: '#3fbfa0',      // 浪尖透光绿
};

const groundSize = 400;
const glowStrengthBase = 6;

const state = {
	ctx: null,
	scene: null,
	ready: false,
	glowToggle: null,
	groundToggle: null,
	glowStrength: null,
	sun: null,
	ring: null,
	buoys: [],
};

function makeMaterial( baseColor, glowColor ) {

	const material = new THREE.MeshStandardNodeMaterial();
	material.roughness = 0.5;
	material.metalness = 0;
	material.colorNode = color( baseColor );
	if ( glowColor ) {

		material.emissiveNode = color( glowColor ).mul( state.glowStrength ).mul( state.glowToggle );

	}

	return material;

}

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '落日场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	state.ctx = ctx;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( palette.sky );

	state.glowToggle = uniform( 1 );
	state.groundToggle = uniform( 1 );
	state.glowStrength = uniform( glowStrengthBase );

	const shadowSize = ctx.quality?.params?.shadowSize ?? 0;

	// 海面
	const seaMaterial = new THREE.MeshStandardNodeMaterial();
	seaMaterial.roughness = 0.25;
	seaMaterial.metalness = 0.1;
	seaMaterial.colorNode = color( palette.sea ).mul( state.groundToggle );
	const sea = new THREE.Mesh( new THREE.PlaneGeometry( groundSize, groundSize ), seaMaterial );
	sea.rotation.x = - Math.PI / 2;
	sea.receiveShadow = shadowSize > 0;
	scene.add( sea );

	// 太阳：远处压在地平线上的大发光球
	const sun = new THREE.Mesh( new THREE.SphereGeometry( 6, 32, 16 ), makeMaterial( palette.sun, palette.sun ) );
	sun.position.set( 0, 4, - 150 );
	scene.add( sun );
	state.sun = sun;

	// 礁石：几块深色八面体
	const rockGeometry = new THREE.OctahedronGeometry( 2.2, 1 );
	const rockMaterial = makeMaterial( palette.rock, null );
	const rockPositions = [ [ - 5, 0.4, - 6 ], [ 6, 0.2, - 10 ], [ - 9, 0.6, - 16 ] ];
	for ( let i = 0; i < rockPositions.length; i ++ ) {

		const rock = new THREE.Mesh( rockGeometry, rockMaterial );
		rock.position.fromArray( rockPositions[ i ] );
		rock.rotation.set( i * 0.7, i * 1.3, 0 );
		rock.castShadow = shadowSize > 0;
		scene.add( rock );

	}

	// 浪尖透光：一圈淡绿发光环浮在水面上
	const ring = new THREE.Mesh( new THREE.TorusGeometry( 3, 0.18, 12, 48 ), makeMaterial( palette.foam, palette.foam ) );
	ring.position.set( 2, 0.3, - 20 );
	ring.rotation.x = Math.PI / 2;
	scene.add( ring );
	state.ring = ring;

	// 浮标：几颗粉色小球随浪起伏
	const buoyGeometry = new THREE.SphereGeometry( 0.5, 16, 12 );
	const buoyMaterial = makeMaterial( palette.midSky, palette.midSky );
	state.buoys = [];
	for ( let i = 0; i < 4; i ++ ) {

		const buoy = new THREE.Mesh( buoyGeometry, buoyMaterial );
		const base = new THREE.Vector3( - 12 + i * 8, 0.5, - 30 - i * 6 );
		buoy.position.copy( base );
		scene.add( buoy );
		state.buoys.push( { mesh: buoy, base, phase: i * 1.7 } );

	}

	// 低角度暖光 + 紫色天顶/深蓝海面的半球光
	const sunLight = new THREE.DirectionalLight( palette.sun, 2.5 );
	sunLight.position.set( 0, 6, - 100 );
	if ( shadowSize > 0 ) {

		sunLight.castShadow = true;
		sunLight.shadow.mapSize.set( shadowSize, shadowSize );
		sunLight.shadow.camera.left = - 40;
		sunLight.shadow.camera.right = 40;
		sunLight.shadow.camera.top = 40;
		sunLight.shadow.camera.bottom = - 40;
		sunLight.shadow.camera.near = 1;
		sunLight.shadow.camera.far = 200;
		sunLight.shadow.camera.updateProjectionMatrix();

	}

	scene.add( sunLight );
	scene.add( new THREE.HemisphereLight( palette.highSky, palette.sea, 0.7 ) );

	state.scene = scene;
	state.ready = true;
	return { scene };

}

export function enter() {

	if ( ! state.ready ) throw new Error( '落日场景：还没 init 就调了 enter' );

	const ctx = state.ctx;
	const sceneConfig = ctx.config.scenes.find( ( item ) => item.key === key );
	if ( ! sceneConfig ) throw new Error( `落日场景：config.scenes 里找不到 key 为 ${ key } 的条目` );
	const duration = sceneConfig.duration;

	// 站在礁石上从低处慢慢升高，最后看向太阳
	ctx.director.setRoute( [
		{ time: 0, position: [ 0, 1.2, 4 ], lookAt: [ 2, 1, - 20 ] },
		{ time: duration * 0.55, position: [ - 1, 3.5, 2 ], lookAt: [ 0, 3, - 80 ] },
		{ time: duration, position: [ 0, 6, 0 ], lookAt: [ 0, 5, - 150 ] },
	] );

	ctx.debug.addLayerToggle( key, '发光体', state.glowToggle );
	ctx.debug.addLayerToggle( key, '地面', state.groundToggle );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;

	// 太阳缓慢下沉一点点，浮标随浪起伏，光环慢慢转
	state.sun.position.y = 4 - time * 0.02;
	state.ring.rotation.z = time * 0.15;
	for ( const buoy of state.buoys ) {

		buoy.mesh.position.y = buoy.base.y + Math.sin( time * 0.9 + buoy.phase ) * 0.35;

	}

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
	state.sun = null;
	state.ring = null;
	state.buoys = [];
	state.glowToggle = null;
	state.groundToggle = null;
	state.glowStrength = null;
	state.ctx = null;
	console.log( '落日场景：已释放' );

}
