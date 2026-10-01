// 场景 5：凌晨极光雪原（阶段 0 简版：深蓝天空 + 淡蓝雪地 + 绿紫发光带当"极光"、月亮、几块黑石和一棵枯树）
// 配色来自规格书第 7 节。真场景在阶段 1 做，这里只跑通流程。

import * as THREE from 'three/webgpu';
import { uniform, color } from 'three/tsl';

export const key = 'aurora';

const palette = {
	sky: '#0d1730',          // 地平线
	zenith: '#03060f',       // 天顶
	snowLit: '#c9d6ee',      // 雪受光面
	snowShade: '#4a5f8c',    // 雪阴影
	auroraGreen: '#3dffa0',
	auroraPurple: '#9a4dff',
	rock: '#0b0d12',
	moon: '#dfe6f7',
};

const groundSize = 400;
const glowStrengthBase = 4;

const state = {
	ctx: null,
	scene: null,
	ready: false,
	glowToggle: null,
	groundToggle: null,
	glowStrength: null,
	bands: [],
	moon: null,
};

function makeMaterial( baseColor, glowColor ) {

	const material = new THREE.MeshStandardNodeMaterial();
	material.roughness = 0.6;
	material.metalness = 0;
	material.colorNode = color( baseColor );
	if ( glowColor ) {

		material.emissiveNode = color( glowColor ).mul( state.glowStrength ).mul( state.glowToggle );

	}

	return material;

}

export async function init( ctx ) {

	if ( state.scene ) {

		console.warn( '雪原场景：init 被重复调用，先释放旧的再重建' );
		dispose();

	}

	state.ctx = ctx;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color( palette.sky );

	state.glowToggle = uniform( 1 );
	state.groundToggle = uniform( 1 );
	state.glowStrength = uniform( glowStrengthBase );

	const shadowSize = ctx.quality?.params?.shadowSize ?? 0;

	// 雪地
	const snowMaterial = new THREE.MeshStandardNodeMaterial();
	snowMaterial.roughness = 0.75;
	snowMaterial.colorNode = color( palette.snowLit ).mul( state.groundToggle );
	const snow = new THREE.Mesh( new THREE.PlaneGeometry( groundSize, groundSize ), snowMaterial );
	snow.rotation.x = - Math.PI / 2;
	snow.receiveShadow = shadowSize > 0;
	scene.add( snow );

	// "极光"：天上三条弯曲的发光带（细长圆环片段），绿为主、一条紫
	state.bands = [];
	const bandColors = [ palette.auroraGreen, palette.auroraGreen, palette.auroraPurple ];
	for ( let i = 0; i < bandColors.length; i ++ ) {

		const band = new THREE.Mesh( new THREE.TorusGeometry( 60 + i * 12, 1.2, 8, 64, Math.PI * 0.9 ), makeMaterial( bandColors[ i ], bandColors[ i ] ) );
		band.position.set( 0, 45 + i * 8, - 140 );
		band.rotation.set( Math.PI * 0.55, 0, Math.PI * 0.05 + i * 0.1 );
		scene.add( band );
		state.bands.push( { mesh: band, phase: i * 2.0 } );

	}

	// 月亮：一侧偏低
	const moon = new THREE.Mesh( new THREE.SphereGeometry( 2.5, 24, 12 ), makeMaterial( palette.moon, palette.moon ) );
	moon.position.set( - 60, 22, - 150 );
	scene.add( moon );
	state.moon = moon;

	// 岩石：脚印尽头几块半埋的黑石
	const rockGeometry = new THREE.DodecahedronGeometry( 1.5, 0 );
	const rockMaterial = makeMaterial( palette.rock, null );
	const rockSpots = [ [ - 3, - 0.4, - 40 ], [ 2, - 0.6, - 42 ], [ 0.5, - 0.3, - 45 ] ];
	for ( let i = 0; i < rockSpots.length; i ++ ) {

		const rock = new THREE.Mesh( rockGeometry, rockMaterial );
		rock.position.fromArray( rockSpots[ i ] );
		rock.rotation.set( i, i * 0.6, 0 );
		rock.castShadow = shadowSize > 0;
		scene.add( rock );

	}

	// 枯树：主干 + 两根斜枝，黑色剪影
	const treeMaterial = makeMaterial( palette.rock, null );
	const trunk = new THREE.Mesh( new THREE.CylinderGeometry( 0.12, 0.3, 7, 8 ), treeMaterial );
	trunk.position.set( 0, 3.5, - 46 );
	trunk.castShadow = shadowSize > 0;
	scene.add( trunk );
	const branchGeometry = new THREE.CylinderGeometry( 0.06, 0.14, 3.5, 6 );
	const branchLeft = new THREE.Mesh( branchGeometry, treeMaterial );
	branchLeft.position.set( - 1.1, 5.6, - 46 );
	branchLeft.rotation.z = Math.PI * 0.3;
	scene.add( branchLeft );
	const branchRight = new THREE.Mesh( branchGeometry, treeMaterial );
	branchRight.position.set( 0.9, 6.2, - 46 );
	branchRight.rotation.z = - Math.PI * 0.25;
	scene.add( branchRight );

	// 冷月光 + 天色/雪影半球光（带一点极光绿）
	const moonLight = new THREE.DirectionalLight( palette.moon, 1.0 );
	moonLight.position.set( - 60, 30, - 100 );
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
	scene.add( new THREE.HemisphereLight( new THREE.Color( palette.sky ).lerp( new THREE.Color( palette.auroraGreen ), 0.15 ), palette.snowShade, 0.6 ) );

	state.scene = scene;
	state.ready = true;
	return { scene };

}

export function enter() {

	if ( ! state.ready ) throw new Error( '雪原场景：还没 init 就调了 enter' );

	const ctx = state.ctx;
	const sceneConfig = ctx.config.scenes.find( ( item ) => item.key === key );
	if ( ! sceneConfig ) throw new Error( `雪原场景：config.scenes 里找不到 key 为 ${ key } 的条目` );
	const duration = sceneConfig.duration;

	// 沿脚印旁平行前进，最后 20 秒停在枯树前缓缓抬头看极光
	ctx.director.setRoute( [
		{ time: 0, position: [ 1.5, 1.65, 0 ], lookAt: [ 0, 12, - 60 ] },
		{ time: duration - 20, position: [ 1.5, 1.65, - 36 ], lookAt: [ 0, 10, - 80 ] },
		{ time: duration, position: [ 1.5, 1.65, - 38 ], lookAt: [ 0, 60, - 120 ] },
	] );

	ctx.debug.addLayerToggle( key, '发光体', state.glowToggle );
	ctx.debug.addLayerToggle( key, '地面', state.groundToggle );

}

export function update( dt, time ) {

	if ( ! state.ready ) return;

	// 极光带缓慢摆动、呼吸
	for ( const band of state.bands ) {

		band.mesh.rotation.z = Math.PI * 0.05 + band.phase * 0.05 + Math.sin( time * 0.1 + band.phase ) * 0.08;
		band.mesh.position.y = 45 + band.phase * 4 + Math.sin( time * 0.15 + band.phase ) * 2;

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
	state.bands = [];
	state.moon = null;
	state.glowToggle = null;
	state.groundToggle = null;
	state.glowStrength = null;
	state.ctx = null;
	console.log( '雪原场景：已释放' );

}
