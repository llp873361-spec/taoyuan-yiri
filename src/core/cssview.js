// CSS 3D 立方体全景（规格书 6.5 兜底）：浏览器连 WebGL2 都拿不到时，用 CSS 3D 变换把同一套全景贴到一个立方体的六个面上，
// 镜头沿 config.panorama 的视角关键帧慢慢转、可以拖动转头，烘焙点之间交叉淡化，地点之间放飞行视频。
// 没有任何实时叠加；需要实时叠加的地点（落日的闪点、雪原的极光和飘雪）烘焙时另存了一张全开的 -full 图，这里优先用它。
// 全景图在这里用 2D canvas 一行行转成立方体的六个面（分很多小段做，不卡住镜头转动）。
import manifest from '../../assets/opt/pano/manifest.json';
import { blobOf, flightVideoOf } from '../scenes/panorama.js';

const degree = Math.PI / 180;
// 每个面的边长（像素）和转面用的全景宽：6144 宽的全景每度 17 像素，1536 的面每度也是 17 像素，正好对上
const faceSize = 1536;
const sourceWidth = 6144;
const rowsPerSlice = 64;          // 每段转多少行，大约 10~20 毫秒，做完让出一帧
const jumpFade = 0.6;             // 方向键跳地点：淡出、淡入各多少秒
const flightFade = 0.6;           // 飞行视频淡入淡出的秒数

// 六个面：forward / right / up 是本地坐标（y 朝上，偏航 0 = 本地 −z，往右为正），place 是把面摆上立方体的 CSS 变换（CSS 的 y 朝下）。
// 侧面：偏航 ψ 的面在 rotateY(−ψ) 上；顶面图的上边朝本地 +z（身后），底面图的上边朝 −z（前方），和烘焙时相机的姿态一致
const faces = [ 0, 90, 180, 270 ].map( ( yaw ) => ( {
	forward: [ Math.sin( yaw * degree ), 0, - Math.cos( yaw * degree ) ],
	right: [ Math.cos( yaw * degree ), 0, Math.sin( yaw * degree ) ],
	up: [ 0, 1, 0 ],
	place: `rotateY(${ - yaw }deg)`,
} ) ).concat( [
	{ forward: [ 0, 1, 0 ], right: [ 1, 0, 0 ], up: [ 0, 0, 1 ], place: 'rotateX(-90deg)' },
	{ forward: [ 0, - 1, 0 ], right: [ 1, 0, 0 ], up: [ 0, 0, - 1 ], place: 'rotateX(90deg)' },
] );

function nextFrame() {

	return new Promise( ( resolve ) => requestAnimationFrame( () => resolve() ) );

}

function smoothStep( edge0, edge1, value ) {

	const t = Math.min( 1, Math.max( 0, ( value - edge0 ) / ( edge1 - edge0 ) ) );
	return t * t * ( 3 - 2 * t );

}

// 一张等距柱状全景 → 六个面的 canvas。约定和 src/scenes/panorama.js 一样：u = 0.5 是本地 −z、往右 u 变大；图的第一行是正上方
async function buildFaces( id ) {

	const bitmap = await createImageBitmap( await blobOf( id ) );
	const sourceHeight = sourceWidth / 2;
	const sourceCanvas = document.createElement( 'canvas' );
	sourceCanvas.width = sourceWidth;
	sourceCanvas.height = sourceHeight;
	const sourceContext = sourceCanvas.getContext( '2d', { willReadFrequently: true } );
	sourceContext.drawImage( bitmap, 0, 0, sourceWidth, sourceHeight );
	bitmap.close();
	const source = sourceContext.getImageData( 0, 0, sourceWidth, sourceHeight ).data;
	sourceCanvas.width = 0;   // 这张大图用完就放掉
	sourceCanvas.height = 0;

	const result = [];
	for ( const face of faces ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = faceSize;
		canvas.height = faceSize;
		const context = canvas.getContext( '2d' );
		const image = context.createImageData( faceSize, faceSize );
		const pixels = image.data;
		const [ fx, fy, fz ] = face.forward;
		const [ rx, ry, rz ] = face.right;
		const [ ux, uy, uz ] = face.up;
		for ( let row = 0; row < faceSize; row ++ ) {

			const y = 1 - 2 * ( row + 0.5 ) / faceSize;
			for ( let column = 0; column < faceSize; column ++ ) {

				const x = 2 * ( column + 0.5 ) / faceSize - 1;
				const dx = fx + x * rx + y * ux;
				const dy = fy + x * ry + y * uy;
				const dz = fz + x * rz + y * uz;
				const azimuth = Math.atan2( dx, - dz );
				const elevation = Math.atan2( dy, Math.sqrt( dx * dx + dz * dz ) );
				// 双线性取色：横向绕回，纵向夹住
				const sx = ( azimuth / ( Math.PI * 2 ) + 0.5 ) * sourceWidth - 0.5;
				const sy = Math.min( sourceHeight - 1.001, Math.max( 0, ( 0.5 - elevation / Math.PI ) * sourceHeight - 0.5 ) );
				const x0 = Math.floor( sx );
				const y0 = Math.floor( sy );
				const tx = sx - x0;
				const ty = sy - y0;
				const left = ( ( x0 % sourceWidth ) + sourceWidth ) % sourceWidth;
				const right = ( left + 1 ) % sourceWidth;
				const top = y0 * sourceWidth;
				const bottom = ( y0 + 1 ) * sourceWidth;
				const a = ( top + left ) * 4;
				const b = ( top + right ) * 4;
				const c = ( bottom + left ) * 4;
				const d = ( bottom + right ) * 4;
				const out = ( row * faceSize + column ) * 4;
				for ( let channel = 0; channel < 3; channel ++ ) {

					const upper = source[ a + channel ] + ( source[ b + channel ] - source[ a + channel ] ) * tx;
					const lower = source[ c + channel ] + ( source[ d + channel ] - source[ c + channel ] ) * tx;
					pixels[ out + channel ] = upper + ( lower - upper ) * ty;

				}

				pixels[ out + 3 ] = 255;

			}

			if ( row % rowsPerSlice === rowsPerSlice - 1 ) await nextFrame();

		}

		context.putImageData( image, 0, 0 );
		result.push( canvas );

	}

	return result;

}

// host：放立方体的容器；audio：createAudio 的结果；onEnd：最后一个地点停完时调
export function createCssView( { host, config, audio, onEnd } ) {

	const panoramaConfig = config.panorama;
	// 有烘焙数据的地点，按时间线顺序
	const stops = config.scenes
		.filter( ( scene ) => manifest.locations && manifest.locations[ scene.key ] && manifest.locations[ scene.key ].points.length > 0 )
		.map( ( scene ) => ( {
			key: scene.key,
			duration: scene.duration,
			points: manifest.locations[ scene.key ].points,
			location: panoramaConfig.locations[ scene.key ] || { points: [], views: [ { time: 0, yaw: 0, pitch: 0, fov: 50 } ] },
		} ) );
	if ( stops.length === 0 ) throw new Error( 'CSS 全景：没有任何烘焙好的地点（先跑 node scripts/bake-pano.mjs 再构建）' );

	// ===== DOM =====
	const root = document.createElement( 'div' );
	root.className = 'cssView';
	const camera = document.createElement( 'div' );
	camera.className = 'cssCamera';
	root.appendChild( camera );
	// 两个立方体轮流用：新的那个缩小一点点（以眼睛为中心缩放，角度不变）挡在旧的前面，按透明度淡进来
	const cubes = [ 0, 1 ].map( () => {

		const element = document.createElement( 'div' );
		element.className = 'cssCube';
		camera.appendChild( element );
		return { element, canvases: [], pointId: null, opacity: 0 };

	} );
	const video = document.createElement( 'video' );
	video.className = 'cssFlight';
	video.muted = true;
	video.playsInline = true;
	video.preload = 'auto';
	root.appendChild( video );
	const curtain = document.createElement( 'div' );
	curtain.className = 'cssCurtain';
	root.appendChild( curtain );
	host.appendChild( root );

	const state = {
		phase: 'idle',      // idle / stay / flight / jump / ended
		stopIndex: 0,
		time: 0,            // 当前阶段的秒数
		paused: false,
		pointIndex: 0,      // 现在显示（或正在淡入）的烘焙点
		fade: null,         // { cube, from, start }：烘焙点之间正在交叉淡化
		frontCube: 0,       // 现在显示的是哪个立方体
		jumpTarget: - 1,
		jumpSwitched: false,
		flightDuration: 0,
		flightReady: false,
		arriving: false,
		videoFading: false,
		fadePending: false,
		dragYaw: 0, dragPitch: 0, dragIdle: 99,
		lastFrame: 0,
		token: 0,
	};
	const faceCache = new Map();   // 烘焙点 id → Promise<canvas[]>
	const videoUrls = new Map();

	function pointSource( point ) {

		return point.full || point.image;

	}

	function facesOf( point ) {

		const id = pointSource( point );
		if ( ! faceCache.has( id ) ) {

			const promise = buildFaces( id ).catch( ( error ) => {

				faceCache.delete( id );
				throw error;

			} );
			faceCache.set( id, promise );

		}

		return faceCache.get( id );

	}

	// 只留现在这个地点和下一个地点的面（每个点的六个面大约 56 MB）
	function trimCache() {

		const keep = new Set();
		for ( const index of [ state.stopIndex, state.stopIndex + 1, state.jumpTarget ] ) {

			const stop = stops[ index ];
			if ( stop ) for ( const point of stop.points ) keep.add( pointSource( point ) );

		}

		for ( const cube of cubes ) if ( cube.pointId ) keep.add( cube.pointId );
		for ( const id of [ ...faceCache.keys() ] ) {

			if ( keep.has( id ) ) continue;
			faceCache.get( id ).then( ( canvases ) => canvases.forEach( ( canvas ) => {

				if ( ! canvas.isConnected ) {

					canvas.width = 0;
					canvas.height = 0;

				}

			} ) ).catch( () => {} );
			faceCache.delete( id );

		}

	}

	// 把一个烘焙点的六个面挂到某个立方体上
	function mount( cube, point, canvases ) {

		const id = pointSource( point );
		if ( cube.pointId === id ) return;
		cube.element.replaceChildren();
		canvases.forEach( ( canvas, i ) => {

			canvas.className = 'cssFace';
			canvas.style.transform = `${ faces[ i ].place } translateZ(${ - faceSize / 2 }px)`;
			cube.element.appendChild( canvas );

		} );
		cube.canvases = canvases;
		cube.pointId = id;

	}

	function setCubeOpacity( cube, opacity ) {

		cube.opacity = opacity;
		// 透明度设在每个面上：设在 preserve-3d 的容器上会把整个立方体拍扁
		for ( const canvas of cube.canvases ) canvas.style.opacity = String( opacity );
		cube.element.style.visibility = opacity > 0.001 ? 'visible' : 'hidden';

	}

	function setFront( index ) {

		state.frontCube = index;
		cubes[ index ].element.style.transform = 'scale3d(0.995, 0.995, 0.995)';
		cubes[ 1 - index ].element.style.transform = 'none';

	}

	// 视角关键帧插值（两帧之间平滑过渡）
	function viewAt( stop, time ) {

		const views = stop.location.views;
		if ( time <= views[ 0 ].time ) return views[ 0 ];
		for ( let i = 1; i < views.length; i ++ ) {

			if ( time <= views[ i ].time ) {

				const a = views[ i - 1 ];
				const b = views[ i ];
				const t = smoothStep( a.time, b.time, time );
				return { yaw: a.yaw + ( b.yaw - a.yaw ) * t, pitch: a.pitch + ( b.pitch - a.pitch ) * t, fov: a.fov + ( b.fov - a.fov ) * t };

			}

		}

		return views[ views.length - 1 ];

	}

	function applyCamera( view ) {

		const height = Math.max( 1, window.innerHeight );
		const perspective = height / 2 / Math.tan( view.fov / 2 * degree );
		root.style.perspective = perspective + 'px';
		const pitch = Math.max( - 85, Math.min( 85, view.pitch + state.dragPitch ) );
		camera.style.transform = `translateZ(${ perspective }px) rotateX(${ pitch }deg) rotateY(${ view.yaw + state.dragYaw }deg)`;

	}

	// ===== 拖动转头：松手 dragReturnDelay 秒后慢慢回正 =====
	let dragging = null;
	root.addEventListener( 'pointerdown', ( event ) => {

		dragging = { x: event.clientX, y: event.clientY };
		root.setPointerCapture( event.pointerId );

	} );
	root.addEventListener( 'pointermove', ( event ) => {

		if ( ! dragging ) return;
		const view = state.phase === 'stay' ? viewAt( stops[ state.stopIndex ], state.time ) : { fov: 50 };
		const degreesPerPixel = view.fov / Math.max( 1, window.innerHeight );
		state.dragYaw = Math.max( - panoramaConfig.dragYawMax, Math.min( panoramaConfig.dragYawMax, state.dragYaw - ( event.clientX - dragging.x ) * degreesPerPixel ) );
		state.dragPitch = Math.max( - panoramaConfig.dragPitchMax, Math.min( panoramaConfig.dragPitchMax, state.dragPitch + ( event.clientY - dragging.y ) * degreesPerPixel ) );
		dragging.x = event.clientX;
		dragging.y = event.clientY;
		state.dragIdle = 0;

	} );
	const endDrag = () => {

		dragging = null;

	};
	root.addEventListener( 'pointerup', endDrag );
	root.addEventListener( 'pointercancel', endDrag );

	// ===== 阶段 =====
	async function beginStay( index ) {

		const token = ++ state.token;
		const stop = stops[ index ];
		const canvases = await facesOf( stop.points[ 0 ] );
		if ( token !== state.token ) return false;
		state.stopIndex = index;
		state.pointIndex = 0;
		state.fade = null;
		state.fadePending = false;
		state.time = 0;
		trimCache();
		const cube = cubes[ 1 - state.frontCube ];
		mount( cube, stop.points[ 0 ], canvases );
		setFront( 1 - state.frontCube );
		setCubeOpacity( cube, 1 );
		setCubeOpacity( cubes[ 1 - state.frontCube ], 0 );
		state.phase = 'stay';
		audio.playScene( stop.key );
		console.log( `CSS 全景：到了「${ stop.key }」` );
		// 后台把这个地点后面的点和下一个地点的第一个点先转好
		for ( const point of stop.points.slice( 1 ) ) facesOf( point ).catch( ( error ) => console.error( 'CSS 全景：转面失败', error ) );
		if ( stops[ index + 1 ] ) facesOf( stops[ index + 1 ].points[ 0 ] ).catch( ( error ) => console.error( 'CSS 全景：转面失败', error ) );
		return true;

	}

	function updateStay( dt ) {

		const stop = stops[ state.stopIndex ];
		state.time += dt;

		// 烘焙点之间交叉淡化：新点的面转好了才开始
		const next = stop.points[ state.pointIndex + 1 ];
		const switchAt = next ? stop.location.points[ state.pointIndex + 1 ] && stop.location.points[ state.pointIndex + 1 ].switchAt : null;
		if ( next && ! state.fade && switchAt !== null && switchAt !== undefined && state.time >= switchAt ) {

			const id = pointSource( next );
			const ready = faceCache.get( id );
			if ( ready && ! state.fadePending ) {

				state.fadePending = true;
				ready.then( ( canvases ) => {

					state.fadePending = false;
					if ( stops[ state.stopIndex ] !== stop || state.phase !== 'stay' ) return;
					const cube = cubes[ 1 - state.frontCube ];
					mount( cube, next, canvases );
					setFront( 1 - state.frontCube );
					setCubeOpacity( cube, 0 );
					state.pointIndex ++;
					state.fade = { start: state.time };

				} ).catch( () => {

					state.fadePending = false;

				} );

			} else if ( ! ready ) {

				facesOf( next ).catch( ( error ) => console.error( 'CSS 全景：转面失败', error ) );

			}

		}

		if ( state.fade ) {

			const amount = Math.min( 1, ( state.time - state.fade.start ) / Math.max( 0.1, panoramaConfig.crossfade ) );
			setCubeOpacity( cubes[ state.frontCube ], amount );
			if ( amount >= 1 ) {

				setCubeOpacity( cubes[ 1 - state.frontCube ], 0 );
				state.fade = null;
				trimCache();

			}

		}

		applyCamera( viewAt( stop, state.time ) );

		if ( state.time >= stop.duration ) {

			if ( state.stopIndex + 1 >= stops.length ) {

				state.phase = 'ended';
				onEnd();

			} else {

				beginFlight();

			}

		}

	}

	// 地点之间：有飞行视频就放视频（淡入盖住旧地点；快放完时在视频下面换成新地点，视频再淡出），没有就黑场淡出淡入
	async function beginFlight() {

		const from = stops[ state.stopIndex ];
		const to = stops[ state.stopIndex + 1 ];
		const flight = flightVideoOf( from.key, to.key );
		if ( ! flight ) {

			startJump( state.stopIndex + 1 );
			return;

		}

		const token = ++ state.token;
		state.phase = 'flight';
		state.time = 0;
		state.flightDuration = flight.duration;
		state.flightReady = false;
		state.arriving = false;
		audio.playScene( 'flight' );
		try {

			if ( ! videoUrls.has( flight.video ) ) videoUrls.set( flight.video, URL.createObjectURL( await blobOf( flight.video ) ) );
			if ( token !== state.token ) return;
			video.src = videoUrls.get( flight.video );
			video.currentTime = 0;
			video.style.opacity = '0';
			await video.play();
			if ( token !== state.token ) return;
			if ( state.paused ) video.pause();
			state.flightReady = true;

		} catch ( error ) {

			console.error( `CSS 全景：飞行视频 ${ from.key } → ${ to.key } 放不了，改成黑场淡出淡入`, error );
			if ( token === state.token ) startJump( state.stopIndex + 1 );

		}

	}

	function updateFlight( dt ) {

		const stop = stops[ state.stopIndex ];
		applyCamera( viewAt( stop, stop.duration ) );
		if ( ! state.flightReady ) return;
		state.time += dt;
		video.style.opacity = String( Math.min( 1, state.time / flightFade ) );
		// 快放完了：在视频下面换成目的地（第一个点没转好就停在视频最后一帧等），换好后视频淡出
		if ( ! state.arriving && state.time >= state.flightDuration - flightFade ) {

			state.arriving = true;
			beginStay( state.stopIndex + 1 ).then( ( ok ) => {

				if ( ok ) state.videoFading = true;

			} ).catch( ( error ) => console.error( 'CSS 全景：下一个地点打不开', error ) );

		}

	}

	function startJump( target ) {

		state.token ++;
		state.phase = 'jump';
		state.jumpTarget = target;
		state.jumpSwitched = false;
		state.time = 0;
		state.arriving = false;

	}

	// 方向键：黑场淡出、换地点、淡入。飞行中按 → 等于直接到目的地，按 ← 回到出发地
	function jump( delta ) {

		if ( state.phase === 'idle' || state.phase === 'jump' ) return false;
		const current = state.phase === 'flight' ? state.stopIndex + ( delta > 0 ? 0 : 1 ) : state.stopIndex;
		const target = current + delta;
		if ( target < 0 || target >= stops.length ) return false;
		startJump( target );
		return true;

	}

	function updateJump( dt ) {

		state.time += dt;
		if ( state.jumpSwitched ) return;
		curtain.style.opacity = String( Math.min( 1, state.time / jumpFade ) );
		if ( state.time < jumpFade ) return;
		state.jumpSwitched = true;
		video.pause();
		video.style.opacity = '0';
		state.videoFading = false;
		beginStay( state.jumpTarget ).then( ( ok ) => {

			if ( ok ) {

				state.phase = 'jumpIn';
				state.time = 0;

			}

		} ).catch( ( error ) => console.error( 'CSS 全景：跳地点失败', error ) );

	}

	// ===== 主循环 =====
	function frame( now ) {

		const dt = state.lastFrame ? Math.min( 0.1, ( now - state.lastFrame ) / 1000 ) : 0;
		state.lastFrame = now;
		requestAnimationFrame( frame );

		state.dragIdle += dt;
		if ( ! dragging && state.dragIdle > panoramaConfig.dragReturnDelay ) {

			const keep = Math.exp( - panoramaConfig.dragReturnDamping * dt );
			state.dragYaw *= keep;
			state.dragPitch *= keep;

		}

		if ( state.paused ) return;
		if ( state.videoFading ) {

			const opacity = Math.max( 0, Number( video.style.opacity || 0 ) - dt / flightFade );
			video.style.opacity = String( opacity );
			if ( opacity <= 0 ) {

				state.videoFading = false;
				video.pause();

			}

		}

		if ( state.phase === 'stay' ) {

			updateStay( dt );

		} else if ( state.phase === 'flight' ) {

			updateFlight( dt );

		} else if ( state.phase === 'jump' ) {

			updateJump( dt );

		} else if ( state.phase === 'jumpIn' ) {

			// 淡入时镜头已经在新地点，时间照常走
			const stop = stops[ state.stopIndex ];
			state.time += dt;
			curtain.style.opacity = String( Math.max( 0, 1 - state.time / jumpFade ) );
			applyCamera( viewAt( stop, state.time ) );
			if ( state.time >= jumpFade ) state.phase = 'stay';

		} else if ( state.phase === 'ended' ) {

			const stop = stops[ state.stopIndex ];
			applyCamera( viewAt( stop, stop.duration ) );

		}

	}

	// 开场卡上调：把第一个地点的第一个点转好（onProgress 给进度粒子用）
	async function prepare( onProgress ) {

		onProgress( 0.2 );
		await facesOf( stops[ 0 ].points[ 0 ] );
		onProgress( 1 );

	}

	async function start() {

		curtain.style.opacity = '1';
		await beginStay( 0 );
		state.phase = 'jumpIn';
		state.time = 0;
		requestAnimationFrame( frame );

	}

	// 再走一遍：从第一个地点重新开始
	function restart() {

		state.paused = false;
		if ( state.phase === 'idle' ) return false;
		startJump( 0 );
		return true;

	}

	function togglePause() {

		state.paused = ! state.paused;
		if ( state.phase === 'flight' && state.flightReady ) {

			if ( state.paused ) video.pause();
			else video.play().catch( () => {} );

		}

		return state.paused;

	}

	function info() {

		return { phase: state.phase, stop: stops[ state.stopIndex ] ? stops[ state.stopIndex ].key : null, time: state.time, point: state.pointIndex, paused: state.paused, cachedPoints: faceCache.size };

	}

	return { prepare, start, restart, jump, togglePause, info, stops: stops.map( ( stop ) => stop.key ) };

}
