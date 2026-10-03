// 飞行航线（规格书 5.3）：地点之间镜头沿一条曲线飞过去。
// 控制点 = [她起飞时站的位置, 往上升起的点, ...航段航点, 下一个地点的出生点]，用 centripetal Catmull-Rom 连成曲线
// （centripetal 不会在控制点挤在一起时打结），每 1 米存一个点，按走过的距离取位置（弧长参数化），速度均匀。
// 离地：每 5 米查一次地面（远景网格画出来的高度和水面取高的），巡航段离地不到 minClearance 的地方往上抬，
// 抬升量先取邻近 ±60 米的最大值、再盒式模糊三遍，航线是平滑地拱起来，不是一个台阶一个台阶地跳。
// 速度：起步、降落用 S(x) = x³ − x⁴/2（速度是 smoothstep，加速度两头都是 0），中间匀速；最快超过 maxSpeed 就自动拉长时间。
// 朝向：巡航时看航线前方、略低头；起飞后几秒从她原来的朝向转过来，降落前几秒转到出生点的朝向；转弯按协调转弯侧倾（不超过 maxBank）。
// 所有结果只由时间决定（没有逐帧积累的状态），截图时跳到任意进度都能复现。
// 先窄后豁然开朗（阶段 12，leg.frame）：航线接在航点后面穿过窄处的中线；入口前 approachRelax 米起不再强制巡航离地；
// 速度分五段：起步加速 → 巡航 → 入口前 slowLead 米减到 frame.speed → 匀速穿过窄处、滑向出生点 → 最后 decelTime 秒停稳；
// 场景在窄处里面（switchAt）切换。窄处对不上（航线不经过、离终点太近）时中文警告，这一段退回原来的薄雾到达。

import * as THREE from 'three/webgpu';

const degree = Math.PI / 180;
const gravity = 9.81;

function clamp( value, low, high ) {

	return Math.min( high, Math.max( low, value ) );

}

function smoothStep( edge0, edge1, value ) {

	const amount = clamp( ( value - edge0 ) / ( edge1 - edge0 ), 0, 1 );
	return amount * amount * ( 3 - 2 * amount );

}

export function smootherStep( edge0, edge1, value ) {

	const amount = clamp( ( value - edge0 ) / ( edge1 - edge0 ), 0, 1 );
	return amount * amount * amount * ( amount * ( amount * 6 - 15 ) + 10 );

}

// 角度差包到 (−π, π]
function wrapAngle( angle ) {

	return Math.atan2( Math.sin( angle ), Math.cos( angle ) );

}

// 从 from 转到 to 要转多少（弧度）：shortest 走近的一边；clockwise 是从上往下看顺时针（方位角变大，three 的偏航角变小）
function turnAmount( from, to, direction ) {

	const shortest = wrapAngle( to - from );
	if ( direction === 'clockwise' ) return shortest > 0 ? shortest - Math.PI * 2 : shortest;
	if ( direction === 'counterclockwise' ) return shortest < 0 ? shortest + Math.PI * 2 : shortest;
	return shortest;

}

// 加速段走过的距离占"全速走同样时间"的比例：S(x) = x³ − x⁴/2，S(1) = 0.5，S'(x) = 3x² − 2x³ 就是 smoothstep
function easedDistance( x ) {

	const clamped = clamp( x, 0, 1 );
	return clamped * clamped * clamped - clamped * clamped * clamped * clamped / 2;

}

// 一维数组的滑动最大值（半宽 radius 个格）
function slidingMax( values, radius ) {

	const result = new Float32Array( values.length );
	for ( let i = 0; i < values.length; i ++ ) {

		let best = 0;
		for ( let j = Math.max( 0, i - radius ); j <= Math.min( values.length - 1, i + radius ); j ++ ) best = Math.max( best, values[ j ] );
		result[ i ] = best;

	}

	return result;

}

function boxBlur( values, radius ) {

	const result = new Float32Array( values.length );
	for ( let i = 0; i < values.length; i ++ ) {

		let sum = 0;
		let count = 0;
		for ( let j = Math.max( 0, i - radius ); j <= Math.min( values.length - 1, i + radius ); j ++ ) {

			sum += values[ j ];
			count ++;

		}

		result[ i ] = sum / count;

	}

	return result;

}

// 四元数 → 偏航、俯仰（弧度，YXZ 顺序：先绕世界 y 转偏航，再绕自己的 x 转俯仰）
const tempEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );
function yawPitchOf( quaternion ) {

	tempEuler.setFromQuaternion( quaternion, 'YXZ' );
	return { yaw: tempEuler.y, pitch: tempEuler.x };

}

// 建一段飞行。
//   groundAt( x, z )：世界里看得见的地面（或水面）高度
//   flightConfig：config.world.flight；leg：config.world.legs 里的一段（没有就只用起点、升起点、终点）
//   start、end：世界坐标的 { position: Vector3, quaternion: Quaternion }
//   label：日志里的航段名字
export function createFlight( { groundAt, flightConfig, leg, start, end, label } ) {

	const settings = { ...flightConfig, ...( leg || {} ) };
	const startAngles = yawPitchOf( start.quaternion );
	const endAngles = yawPitchOf( end.quaternion );

	// ---------- 控制点 ----------
	const waypoints = ( leg && Array.isArray( leg.waypoints ) ? leg.waypoints : [] ).map( ( point ) => new THREE.Vector3().fromArray( point ) );
	// 她起飞前走过了头几个航点（离下一个航点比那个航点本身还近），这几个就不用回头去飞了
	while ( waypoints.length >= 2 && start.position.distanceTo( waypoints[ 1 ] ) < waypoints[ 0 ].distanceTo( waypoints[ 1 ] ) ) waypoints.shift();

	const firstTarget = waypoints.length > 0 ? waypoints[ 0 ] : end.position;
	const towardFirst = new THREE.Vector3( firstTarget.x - start.position.x, 0, firstTarget.z - start.position.z );
	if ( towardFirst.lengthSq() < 1e-6 ) towardFirst.set( - Math.sin( startAngles.yaw ), 0, - Math.cos( startAngles.yaw ) );
	towardFirst.normalize();
	const liftPoint = start.position.clone().addScaledVector( towardFirst, settings.liftDrift ).add( new THREE.Vector3( 0, settings.liftHeight, 0 ) );

	// 窄处：中线接在航点后面
	let frame = leg && leg.frame && Array.isArray( leg.frame.path ) && leg.frame.path.length >= 2 ? { ...flightConfig.frameDefaults, ...leg.frame } : null;
	const framePoints = frame ? frame.path.map( ( point ) => new THREE.Vector3().fromArray( point ) ) : [];
	// 出了窄处到出生点之间的滑翔点（可选；落日：顺着小溪滑下草甸，不从沙丘上翻过去）
	const glidePoints = frame && Array.isArray( frame.glide ) ? frame.glide.map( ( point ) => new THREE.Vector3().fromArray( point ) ) : [];
	const controlPoints = [ start.position.clone(), liftPoint, ...waypoints, ...framePoints, ...glidePoints, end.position.clone() ];
	for ( const point of controlPoints ) {

		if ( ! Number.isFinite( point.x ) || ! Number.isFinite( point.y ) || ! Number.isFinite( point.z ) ) {

			throw new Error( `飞行：${ label } 的航线点不是有效数字（起点 ${ start.position.toArray().join( ',' ) }，终点 ${ end.position.toArray().join( ',' ) }）` );

		}

	}
	const curve = new THREE.CatmullRomCurve3( controlPoints, false, 'centripetal' );
	const rawLength = curve.getLength();
	curve.arcLengthDivisions = Math.max( 200, Math.ceil( rawLength / 2 ) );
	curve.updateArcLengths();
	const curveLength = curve.getLength();

	// ---------- 离地：每 5 米查一次，抬起巡航段太低的地方 ----------
	const probeStep = 5;
	const probeCount = Math.max( 2, Math.ceil( curveLength / probeStep ) + 1 );
	const deficits = new Float32Array( probeCount );
	const probePoint = new THREE.Vector3();
	const rampStart = settings.rampDistance;
	const rampEnd = settings.rampEndDistance || settings.rampDistance;
	// 窄处入口在曲线上的大概位置（还没抬升的曲线，2 米一步找离入口最近的点）
	let rawFrameEntry = Infinity;
	if ( frame ) {

		let best = Infinity;
		for ( let distance = 0; distance <= curveLength; distance += 2 ) {

			curve.getPointAt( Math.min( 1, distance / curveLength ), probePoint );
			const gap = probePoint.distanceTo( framePoints[ 0 ] );
			if ( gap < best ) {

				best = gap;
				rawFrameEntry = distance;

			}

		}

	}

	for ( let i = 0; i < probeCount; i ++ ) {

		const distance = Math.min( curveLength, i * probeStep );
		curve.getPointAt( Math.min( 1, distance / curveLength ), probePoint );
		// 窄处入口前 approachRelax 米起慢慢不再要求巡航高度（只要求离地 2 米以上）
		const relax = frame ? smoothStep( rawFrameEntry - frame.approachRelax, rawFrameEntry - frame.approachRelax * 0.35, distance ) : 0;
		const weight = smoothStep( 0, rampStart, distance ) * smoothStep( 0, rampEnd, curveLength - distance ) * ( 1 - relax );
		const required = groundAt( probePoint.x, probePoint.z ) + settings.minClearance * weight + 2 * relax;
		deficits[ i ] = Math.max( 0, required - probePoint.y );

	}

	let lift = slidingMax( deficits, Math.round( 60 / probeStep ) );
	for ( let pass = 0; pass < 3; pass ++ ) lift = boxBlur( lift, Math.round( 40 / probeStep ) );

	// ---------- 每 1 米一个点（已抬升），再按真实折线长度做弧长表 ----------
	const denseCount = Math.max( 2, Math.ceil( curveLength ) + 1 );
	const densePoints = new Float32Array( denseCount * 3 );
	const cumulative = new Float32Array( denseCount );
	let previousX = 0;
	let previousY = 0;
	let previousZ = 0;
	for ( let i = 0; i < denseCount; i ++ ) {

		// 参数直接用 i / (n − 1)：distance / curveLength 的浮点误差会让它比 1 多一点，three 的弧长查表越界返回 NaN
		const fraction = i / ( denseCount - 1 );
		const distance = curveLength * fraction;
		curve.getPointAt( fraction, probePoint );
		const probeIndex = distance / probeStep;
		const lower = Math.min( probeCount - 1, Math.floor( probeIndex ) );
		const upper = Math.min( probeCount - 1, lower + 1 );
		const liftHere = lift[ lower ] + ( lift[ upper ] - lift[ lower ] ) * ( probeIndex - lower );
		densePoints[ i * 3 ] = probePoint.x;
		densePoints[ i * 3 + 1 ] = probePoint.y + liftHere;
		densePoints[ i * 3 + 2 ] = probePoint.z;
		if ( i > 0 ) cumulative[ i ] = cumulative[ i - 1 ] + Math.hypot( probePoint.x - previousX, probePoint.y + liftHere - previousY, probePoint.z - previousZ );
		previousX = probePoint.x;
		previousY = probePoint.y + liftHere;
		previousZ = probePoint.z;

	}

	const length = cumulative[ denseCount - 1 ];

	// 按走过的距离取折线上的点
	function pointAtDistance( distance, target ) {

		const clamped = clamp( distance, 0, length );
		let low = 0;
		let high = denseCount - 1;
		while ( high - low > 1 ) {

			const middle = ( low + high ) >> 1;
			if ( cumulative[ middle ] <= clamped ) low = middle;
			else high = middle;

		}

		const span = cumulative[ high ] - cumulative[ low ];
		const amount = span > 1e-6 ? ( clamped - cumulative[ low ] ) / span : 0;
		return target.set(
			densePoints[ low * 3 ] + ( densePoints[ high * 3 ] - densePoints[ low * 3 ] ) * amount,
			densePoints[ low * 3 + 1 ] + ( densePoints[ high * 3 + 1 ] - densePoints[ low * 3 + 1 ] ) * amount,
			densePoints[ low * 3 + 2 ] + ( densePoints[ high * 3 + 2 ] - densePoints[ low * 3 + 2 ] ) * amount,
		);

	}

	// ---------- 窄处在航线上的位置（抬升以后的折线，按距离）----------
	function nearestDistance( target ) {

		let best = Infinity;
		let bestDistance = 0;
		for ( let i = 0; i < denseCount; i ++ ) {

			const gap = Math.hypot( densePoints[ i * 3 ] - target.x, densePoints[ i * 3 + 1 ] - target.y, densePoints[ i * 3 + 2 ] - target.z );
			if ( gap < best ) {

				best = gap;
				bestDistance = cumulative[ i ];

			}

		}

		return { distance: bestDistance, gap: best };

	}

	let frameInfo = null;
	if ( frame ) {

		const entry = nearestDistance( framePoints[ 0 ] );
		const exit = nearestDistance( framePoints[ framePoints.length - 1 ] );
		const holdStart = entry.distance - frame.slowLead;
		const tail = length - exit.distance;
		let problem = null;
		if ( entry.gap > 3 || exit.gap > 3 ) problem = `航线离窄处中线太远（入口差 ${ entry.gap.toFixed( 1 )} 米、出口差 ${ exit.gap.toFixed( 1 ) } 米，多半是被离地抬升推开了）`;
		else if ( exit.distance <= entry.distance + 5 ) problem = '窄处的入口不在出口前面';
		else if ( tail < frame.speed * settings.decelTime / 2 ) problem = `出口离出生点只有 ${ tail.toFixed( 0 ) } 米，停不稳`;
		else if ( holdStart < 200 ) problem = `入口离起点只有 ${ entry.distance.toFixed( 0 ) } 米，来不及减速`;
		if ( problem ) {

			console.warn( `飞行：${ label } 的窄处「${ frame.name || frame.kind }」对不上：${ problem }；这一段退回原来的薄雾到达` );
			frame = null;

		} else {

			frameInfo = { entryDistance: entry.distance, exitDistance: exit.distance, switchDistance: entry.distance + ( exit.distance - entry.distance ) * frame.switchAt, holdStart };

		}

	}

	// ---------- 速度和时长 ----------
	// 五段（时间域）：加速（0 → 巡航 v）、巡航、减速（v → 窄处速度 w）、匀速（w）、停稳（w → 0）。
	// 加减速的速度曲线是 smoothstep，走过的距离用 easedDistance 解析算。没有窄处时 w = v、减速段为 0，就是原来的三段
	const accelTime = settings.accelTime;
	const decelTime = settings.decelTime;
	let duration = Math.max( settings.duration || 0, accelTime + decelTime + 1 );
	let cruiseSpeed = 0;
	let slowTime = 0;
	let holdTime = 0;
	let holdSpeed = 0;
	let cruiseTime = 0;
	if ( frameInfo ) {

		holdSpeed = frame.speed;
		slowTime = frame.slowTime;
		// 匀速段从 holdStart 一直到停稳段开始（停稳段走 w·decel/2 米）
		holdTime = ( length - frameInfo.holdStart - holdSpeed * decelTime / 2 ) / holdSpeed;
		const before = frameInfo.holdStart;
		cruiseTime = duration - accelTime - slowTime - holdTime - decelTime;
		cruiseSpeed = cruiseTime > 0 ? ( before - holdSpeed * slowTime / 2 ) / ( accelTime / 2 + cruiseTime + slowTime / 2 ) : Infinity;
		if ( cruiseSpeed > settings.maxSpeed || cruiseTime <= 0 ) {

			cruiseSpeed = settings.maxSpeed;
			cruiseTime = Math.max( 0, ( before - holdSpeed * slowTime / 2 ) / cruiseSpeed - accelTime / 2 - slowTime / 2 );
			duration = accelTime + cruiseTime + slowTime + holdTime + decelTime;
			console.log( `飞行：${ label } 航线 ${ length.toFixed( 0 ) } 米，按 ${ settings.maxSpeed } 米/秒的上限，飞行时间拉长到 ${ duration.toFixed( 1 ) } 秒` );

		}

	} else {

		cruiseSpeed = length / ( duration - ( accelTime + decelTime ) / 2 );
		if ( cruiseSpeed > settings.maxSpeed ) {

			duration = length / settings.maxSpeed + ( accelTime + decelTime ) / 2;
			cruiseSpeed = settings.maxSpeed;
			console.log( `飞行：${ label } 航线 ${ length.toFixed( 0 ) } 米，按 ${ settings.maxSpeed } 米/秒的上限，飞行时间拉长到 ${ duration.toFixed( 1 ) } 秒` );

		}

		holdSpeed = cruiseSpeed;
		cruiseTime = duration - accelTime - decelTime;

	}

	const accelEnd = accelTime;
	const cruiseEnd = accelEnd + cruiseTime;
	const slowEnd = cruiseEnd + slowTime;
	const holdEnd = slowEnd + holdTime;
	const accelDistance = cruiseSpeed * accelTime / 2;
	const cruiseDistance = accelDistance + cruiseSpeed * cruiseTime;
	const slowDistance = cruiseDistance + ( cruiseSpeed + holdSpeed ) * slowTime / 2;

	function distanceAt( time ) {

		if ( time <= 0 ) return 0;
		if ( time >= duration ) return length;
		if ( time < accelEnd ) return cruiseSpeed * accelTime * easedDistance( time / accelTime );
		if ( time < cruiseEnd ) return accelDistance + cruiseSpeed * ( time - accelEnd );
		if ( time < slowEnd ) {

			const elapsed = time - cruiseEnd;
			return cruiseDistance + cruiseSpeed * elapsed + ( holdSpeed - cruiseSpeed ) * slowTime * easedDistance( elapsed / slowTime );

		}

		if ( time < holdEnd ) return slowDistance + holdSpeed * ( time - slowEnd );
		return length - holdSpeed * decelTime * easedDistance( ( duration - time ) / decelTime );

	}

	function speedAt( time ) {

		if ( time <= 0 || time >= duration ) return 0;
		if ( time < accelEnd ) return cruiseSpeed * smoothStep( 0, 1, time / accelTime );
		if ( time < cruiseEnd ) return cruiseSpeed;
		if ( time < slowEnd ) return cruiseSpeed + ( holdSpeed - cruiseSpeed ) * smoothStep( 0, 1, ( time - cruiseEnd ) / slowTime );
		if ( time < holdEnd ) return holdSpeed;
		return holdSpeed * smoothStep( 0, 1, ( duration - time ) / decelTime );

	}

	// 走到某个距离是第几秒（distanceAt 单调递增，二分）
	function timeAtDistance( distance ) {

		let low = 0;
		let high = duration;
		for ( let i = 0; i < 40; i ++ ) {

			const middle = ( low + high ) / 2;
			if ( distanceAt( middle ) < distance ) low = middle;
			else high = middle;

		}

		return ( low + high ) / 2;

	}

	// ---------- 航线本身的朝向（按距离差分，没有逐帧状态）----------
	const aheadPoint = new THREE.Vector3();
	const behindPoint = new THREE.Vector3();

	// 航向用前后 10 米，升降角用前后 40 米（过崖顶、山脊时视线俯仰不会一下子翻过去）
	function headingAt( distance ) {

		pointAtDistance( distance - 10, behindPoint );
		pointAtDistance( distance + 10, aheadPoint );
		const yaw = Math.atan2( - ( aheadPoint.x - behindPoint.x ), - ( aheadPoint.z - behindPoint.z ) );
		pointAtDistance( distance - 40, behindPoint );
		pointAtDistance( distance + 40, aheadPoint );
		const horizontal = Math.hypot( aheadPoint.x - behindPoint.x, aheadPoint.z - behindPoint.z );
		return { yaw, climb: Math.atan2( aheadPoint.y - behindPoint.y, Math.max( horizontal, 1e-3 ) ) };

	}

	// ---------- 报一下这条航线 ----------
	let lowest = Infinity;
	let highest = - Infinity;
	const reportEnd = frameInfo ? Math.min( length - rampEnd, frameInfo.entryDistance - frame.approachRelax ) : length - rampEnd;
	for ( let distance = rampStart; distance <= reportEnd; distance += 10 ) {

		pointAtDistance( distance, probePoint );
		const clearance = probePoint.y - groundAt( probePoint.x, probePoint.z );
		lowest = Math.min( lowest, clearance );
		highest = Math.max( highest, clearance );

	}

	const clearanceText = Number.isFinite( lowest ) ? `，巡航离地 ${ lowest.toFixed( 0 ) }~${ highest.toFixed( 0 ) } 米` : '';

	// ---------- 交接时刻 ----------
	const veil = settings.veil;
	const departSwitchAt = veil.departIn + veil.departHold / 2;
	let arriveSwitchAt = duration - veil.clearBeforeEnd - veil.arriveOut - veil.arriveHold / 2;
	if ( frameInfo ) {

		frameInfo.entryTime = timeAtDistance( frameInfo.entryDistance );
		frameInfo.exitTime = timeAtDistance( frameInfo.exitDistance );
		frameInfo.switchTime = timeAtDistance( frameInfo.switchDistance );
		frameInfo.settings = frame;
		arriveSwitchAt = frameInfo.switchTime;

	}

	const frameText = frameInfo ? `；窄处「${ frame.name }」在第 ${ frameInfo.entryTime.toFixed( 1 ) }~${ frameInfo.exitTime.toFixed( 1 ) } 秒，第 ${ frameInfo.switchTime.toFixed( 1 ) } 秒在里面换场景` : '';
	console.log( `飞行：${ label } 航线 ${ length.toFixed( 0 ) } 米，${ duration.toFixed( 1 ) } 秒，最快 ${ cruiseSpeed.toFixed( 0 ) } 米/秒${ clearanceText }${ frameText }` );

	// ---------- 按时间取位姿 ----------
	const departTurn = settings.departTurn;
	const arriveTurn = settings.arriveTurn;
	const departDirection = settings.departTurnDirection || 'shortest';
	const arriveDirection = settings.arriveTurnDirection || 'shortest';
	const maxBank = settings.maxBank * degree;
	const pitchLimit = settings.lookPitchLimit * degree;
	const pitchBias = settings.lookPitchBias * degree;
	const poseEuler = new THREE.Euler( 0, 0, 0, 'YXZ' );

	// 某一刻转弯该有的侧倾（弧度，左转为正）。按协调转弯 tan(φ) = v·ω / g 算，再乘 bankGain（0.35）：
	// 70 米/秒时真实的协调转弯在 4 公里半径的弯上就要倾 8°，画面上太晕，这里按三分之一给，大弯再软饱和到 maxBank。
	// v、ω 都按水平方向算（竖直爬升时水平速度很小、航向会抖，按水平算就不会乱晃）
	const bankGain = 0.35;
	function rawBankAt( time ) {

		const distance = distanceAt( time );
		const speed = speedAt( time );
		if ( speed < 0.1 ) return 0;
		const climb = headingAt( distance ).climb;
		const span = Math.max( 50, speed * 1.2 );
		const turnRate = wrapAngle( headingAt( distance + span ).yaw - headingAt( distance - span ).yaw ) / ( 2 * span / speed );
		const horizontalSpeed = speed * Math.cos( climb );
		const physical = Math.atan( bankGain * horizontalSpeed * turnRate * Math.cos( climb ) / gravity );
		return maxBank * Math.tanh( physical / maxBank );

	}

	// pose：{ position: Vector3, quaternion: Quaternion }，都是世界坐标；返回这一刻的速度（米/秒）
	function sample( time, pose ) {

		const clampedTime = clamp( time, 0, duration );
		const distance = distanceAt( clampedTime );
		const speed = speedAt( clampedTime );
		pointAtDistance( distance, pose.position );

		const heading = headingAt( distance );
		const pathPitch = clamp( heading.climb * settings.lookPitchFollow, - pitchLimit, pitchLimit ) + pitchBias;

		// 起飞后从她原来的朝向转到航线方向，降落前转到出生点的朝向
		const departWeight = 1 - smootherStep( 0, departTurn, clampedTime );
		const arriveWeight = smootherStep( duration - arriveTurn, duration, clampedTime );
		let yaw = heading.yaw;
		let pitch = pathPitch;
		yaw += departWeight * turnAmount( heading.yaw, startAngles.yaw, departDirection === 'shortest' ? 'shortest' : ( departDirection === 'clockwise' ? 'counterclockwise' : 'clockwise' ) );
		pitch += departWeight * ( startAngles.pitch - pathPitch );
		yaw += arriveWeight * turnAmount( heading.yaw, endAngles.yaw, arriveDirection );
		pitch += arriveWeight * ( endAngles.pitch - pathPitch );

		// 侧倾：前后各 1 秒、5 个时刻取平均（S 形弯不会一秒内从左倾翻到右倾）
		let bank = 0;
		for ( let k = - 2; k <= 2; k ++ ) bank += rawBankAt( clamp( clampedTime + k * 0.5, 0, duration ) );
		const roll = bank / 5 * ( 1 - departWeight ) * ( 1 - arriveWeight );

		poseEuler.set( pitch, yaw, roll, 'YXZ' );
		pose.quaternion.setFromEuler( poseEuler );
		return speed;

	}

	return {
		label,
		duration,
		length,
		cruiseSpeed,
		departSwitchAt,
		arriveSwitchAt,
		frame: frameInfo,
		sample,
		pointAtDistance,
		distanceAt,
		timeAtDistance,
	};

}
