// 音频（规格书 12.4）：素材没到位，全部用 Web Audio 程序化合成，不静音。开场点击之前不建 AudioContext、不出声；
// 每个地点一段环境声，地点之间交叉淡入淡出（config.audio.crossfade 秒），外加一段贯穿全程的轻音乐。
// 环境声的种类（config.audio.scenes[key].kind）：
//   wind 风（滤波噪声 + 两个 LFO：滤波频率和音量一阵一阵）；waves 海浪（音量起伏更深更慢）；
//   night 夜（低沉的风 + 每 2~5 秒一声短促的虫鸣）；quiet 几乎安静；
//   stream 溪流（带通噪声的中心频率每几十毫秒随机跳，像水的咕嘟声，底下一层低的水声）+ 船桨（几秒一下闷闷的划水声，离船以后停）；
//   birds 鸟鸣微风（风 + 一串串短促、带滑音的鸟叫，左右随机）。
// 轻音乐：很软的和声垫（每个和弦四个音、每个音两只略微走调的三角波，低通，慢起慢收，四个和弦循环）
// + 偶尔几个八音盒式的五声音阶单音；都过一个反馈延迟当混响。音量很低，是背景

export function createAudio( ctx ) {

	const audioConfig = ctx.config.audio;

	let context = null;
	let masterGain = null;
	let ambienceBus = null;
	let musicBus = null;
	let delayInput = null;
	let noiseBuffer = null;
	let current = null;         // 当前环境声的链路 { key, nodes: [], gain, timers: [] }
	let muted = false;
	let unavailable = false;
	let oarsOn = true;
	const musicTimers = [];

	function makeNoiseBuffer( audioContext ) {

		// 2 秒白噪声循环，够长就听不出接缝
		const seconds = 2;
		const length = Math.floor( audioContext.sampleRate * seconds );
		const buffer = audioContext.createBuffer( 1, length, audioContext.sampleRate );
		const data = buffer.getChannelData( 0 );
		for ( let i = 0; i < length; i ++ ) data[ i ] = Math.random() * 2 - 1;
		return buffer;

	}

	function unlock() {

		if ( context || unavailable ) return;
		const AudioContextClass = window.AudioContext || window.webkitAudioContext;
		if ( ! AudioContextClass ) {

			unavailable = true;
			console.warn( '音频：这个浏览器没有 AudioContext，全程静音' );
			return;

		}

		try {

			context = new AudioContextClass();

		} catch ( error ) {

			unavailable = true;
			console.warn( '音频：AudioContext 创建失败，全程静音：', error );
			return;

		}

		masterGain = context.createGain();
		masterGain.gain.value = muted ? 0 : audioConfig.masterVolume;
		masterGain.connect( context.destination );
		ambienceBus = context.createGain();
		ambienceBus.connect( masterGain );
		musicBus = context.createGain();
		musicBus.gain.value = 0;
		musicBus.connect( masterGain );
		// 混响：一条反馈延迟（0.37 秒、反馈 0.35，过低通），音乐和鸟叫都送一点进去
		delayInput = context.createGain();
		const delay = context.createDelay( 1 );
		delay.delayTime.value = 0.37;
		const feedback = context.createGain();
		feedback.gain.value = 0.35;
		const damping = context.createBiquadFilter();
		damping.type = 'lowpass';
		damping.frequency.value = 2200;
		delayInput.connect( delay );
		delay.connect( damping );
		damping.connect( feedback );
		feedback.connect( delay );
		damping.connect( masterGain );
		noiseBuffer = makeNoiseBuffer( context );

		// resume 必须在用户手势里同步调用；返回的 Promise 不用等
		context.resume().then( () => {

			console.log( '音频：已解锁，状态 ' + context.state );

		} ).catch( ( error ) => {

			console.warn( '音频：resume 失败：', error );

		} );

		startMusic();

	}

	// ===================== 环境声 =====================

	function noiseSource( now, nodes ) {

		const source = context.createBufferSource();
		source.buffer = noiseBuffer;
		source.loop = true;
		// 每条链从噪声的不同位置开始，几条叠在一起不会相关
		source.start( now, Math.random() * 1.9 );
		nodes.push( source );
		return source;

	}

	// 风：噪声 → 低通 → 音量；LFO 晃滤波频率和音量（风一阵一阵）
	function addWind( sceneAudio, now, nodes, output, volumeScale = 1 ) {

		const source = noiseSource( now, nodes );
		const filter = context.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.value = sceneAudio.cutoff;
		filter.Q.value = 0.7;
		const gain = context.createGain();
		gain.gain.value = volumeScale;
		source.connect( filter );
		filter.connect( gain );
		gain.connect( output );
		const lfo = context.createOscillator();
		lfo.frequency.value = sceneAudio.lfoRate;
		const lfoDepth = context.createGain();
		lfoDepth.gain.value = sceneAudio.cutoff * 0.45;
		lfo.connect( lfoDepth );
		lfoDepth.connect( filter.frequency );
		lfo.start( now );
		const isWaves = sceneAudio.kind === 'waves';
		const volumeLfo = context.createOscillator();
		volumeLfo.frequency.value = isWaves ? sceneAudio.lfoRate * 0.6 : sceneAudio.lfoRate * 1.7;
		const volumeDepth = context.createGain();
		volumeDepth.gain.value = volumeScale * ( isWaves ? 0.6 : 0.25 );
		volumeLfo.connect( volumeDepth );
		volumeDepth.connect( gain.gain );
		volumeLfo.start( now );
		nodes.push( filter, gain, lfo, lfoDepth, volumeLfo, volumeDepth );

	}

	// 溪流：带通噪声的中心频率每 40~90 毫秒随机跳一下（咕嘟咕嘟），音量也跟着抖；底下一层低沉的水声
	function addStream( sceneAudio, now, nodes, timers, output, key ) {

		const babble = noiseSource( now, nodes );
		const band = context.createBiquadFilter();
		band.type = 'bandpass';
		band.frequency.value = 1200;
		band.Q.value = 3.2;
		const babbleGain = context.createGain();
		babbleGain.gain.value = 0.55;
		babble.connect( band );
		band.connect( babbleGain );
		babbleGain.connect( output );
		const rumble = noiseSource( now, nodes );
		const low = context.createBiquadFilter();
		low.type = 'lowpass';
		low.frequency.value = 320;
		const rumbleGain = context.createGain();
		rumbleGain.gain.value = 0.45;
		rumble.connect( low );
		low.connect( rumbleGain );
		rumbleGain.connect( output );
		nodes.push( band, babbleGain, low, rumbleGain );
		const jump = () => {

			if ( ! context || current === null || current.key !== key ) return;
			const time = context.currentTime;
			band.frequency.setTargetAtTime( 500 + Math.random() * 2300, time, 0.015 );
			babbleGain.gain.setTargetAtTime( 0.3 + Math.random() * 0.5, time, 0.02 );
			timers.push( setTimeout( jump, 40 + Math.random() * 50 ) );

		};

		timers.push( setTimeout( jump, 50 ) );
		// 船桨：每 3.6 秒左右一下——闷的划水声（低通噪声，快起慢落）+ 桨离水时几滴水（短促的高音）
		const oar = () => {

			if ( ! context || current === null || current.key !== key ) return;
			if ( oarsOn ) {

				const time = context.currentTime;
				const splash = context.createBufferSource();
				splash.buffer = noiseBuffer;
				const splashFilter = context.createBiquadFilter();
				splashFilter.type = 'lowpass';
				splashFilter.frequency.value = 650;
				const splashGain = context.createGain();
				splashGain.gain.setValueAtTime( 0, time );
				splashGain.gain.linearRampToValueAtTime( 0.9, time + 0.06 );
				splashGain.gain.exponentialRampToValueAtTime( 0.001, time + 0.7 );
				splash.connect( splashFilter );
				splashFilter.connect( splashGain );
				splashGain.connect( output );
				splash.start( time, Math.random() * 1.2 );
				splash.stop( time + 0.75 );
				for ( let drop = 0; drop < 3; drop ++ ) {

					const dropTime = time + 0.9 + drop * ( 0.12 + Math.random() * 0.1 );
					const tone = context.createOscillator();
					tone.frequency.setValueAtTime( 1500 + Math.random() * 900, dropTime );
					tone.frequency.exponentialRampToValueAtTime( 900, dropTime + 0.06 );
					const toneGain = context.createGain();
					toneGain.gain.setValueAtTime( 0.12, dropTime );
					toneGain.gain.exponentialRampToValueAtTime( 0.001, dropTime + 0.08 );
					tone.connect( toneGain );
					toneGain.connect( output );
					tone.start( dropTime );
					tone.stop( dropTime + 0.1 );

				}

			}

			timers.push( setTimeout( oar, 3300 + Math.random() * 600 ) );

		};

		timers.push( setTimeout( oar, 1800 ) );

	}

	// 鸟叫：每 1~4 秒一串，2~5 声，每声 80~150 毫秒、频率往上或往下滑，左右随机；送一点进混响
	function addBirds( sceneAudio, now, nodes, timers, output, key ) {

		const song = () => {

			if ( ! context || current === null || current.key !== key ) return;
			let time = context.currentTime + 0.05;
			const notes = 2 + Math.floor( Math.random() * 4 );
			const base = 2400 + Math.random() * 1800;
			const pan = context.createStereoPanner ? context.createStereoPanner() : null;
			const voiceGain = context.createGain();
			voiceGain.gain.value = sceneAudio.volume * ( 0.5 + Math.random() * 0.6 );
			if ( pan ) {

				pan.pan.value = Math.random() * 1.6 - 0.8;
				voiceGain.connect( pan );
				pan.connect( output );

			} else {

				voiceGain.connect( output );

			}

			voiceGain.connect( delayInput );
			for ( let n = 0; n < notes; n ++ ) {

				const length = 0.08 + Math.random() * 0.07;
				const tone = context.createOscillator();
				const start = base * ( 0.85 + Math.random() * 0.3 );
				tone.frequency.setValueAtTime( start, time );
				tone.frequency.exponentialRampToValueAtTime( start * ( Math.random() < 0.5 ? 1.35 : 0.75 ), time + length );
				const toneGain = context.createGain();
				toneGain.gain.setValueAtTime( 0, time );
				toneGain.gain.linearRampToValueAtTime( 1, time + 0.012 );
				toneGain.gain.exponentialRampToValueAtTime( 0.001, time + length );
				tone.connect( toneGain );
				toneGain.connect( voiceGain );
				tone.start( time );
				tone.stop( time + length + 0.02 );
				time += length + 0.03 + Math.random() * 0.06;

			}

			timers.push( setTimeout( song, 1000 + Math.random() * 3000 ) );

		};

		timers.push( setTimeout( song, 800 ) );

	}

	// 夜虫：每 2~5 秒一声短促的高频
	function addInsects( sceneAudio, timers, output, key ) {

		const chirp = () => {

			if ( ! context || current === null || current.key !== key ) return;
			const start = context.currentTime;
			const tone = context.createOscillator();
			tone.frequency.value = 3800 + Math.random() * 1200;
			const chirpGain = context.createGain();
			chirpGain.gain.setValueAtTime( 0, start );
			chirpGain.gain.linearRampToValueAtTime( sceneAudio.volume * 0.5, start + 0.03 );
			chirpGain.gain.linearRampToValueAtTime( 0, start + 0.18 );
			tone.connect( chirpGain );
			chirpGain.connect( output );
			tone.start( start );
			tone.stop( start + 0.2 );
			timers.push( setTimeout( chirp, 2000 + Math.random() * 3000 ) );

		};

		timers.push( setTimeout( chirp, 1500 ) );

	}

	function buildChain( key ) {

		const sceneAudio = audioConfig.scenes[ key ];
		if ( ! sceneAudio ) {

			console.warn( `音频：config.audio.scenes 里没有 ${ key }，这个场景静音` );
			return null;

		}

		const now = context.currentTime;
		const nodes = [];
		const timers = [];
		const gain = context.createGain();
		gain.gain.value = 0;
		gain.connect( ambienceBus );
		nodes.push( gain );
		const kind = sceneAudio.kind;
		if ( kind === 'stream' ) {

			addStream( sceneAudio, now, nodes, timers, gain, key );
			addWind( { ...sceneAudio, kind: 'wind' }, now, nodes, gain, 0.25 );

		} else if ( kind === 'birds' ) {

			addWind( { ...sceneAudio, kind: 'wind' }, now, nodes, gain, 0.6 );
			addBirds( sceneAudio, now, nodes, timers, gain, key );

		} else {

			addWind( sceneAudio, now, nodes, gain, 1 );
			if ( kind === 'night' ) addInsects( sceneAudio, timers, gain, key );

		}

		return { key, nodes, gain, timers, targetVolume: sceneAudio.volume };

	}

	function fadeOutAndStop( chain ) {

		const now = context.currentTime;
		const crossfade = audioConfig.crossfade;
		chain.gain.gain.cancelScheduledValues( now );
		chain.gain.gain.setValueAtTime( chain.gain.gain.value, now );
		chain.gain.gain.linearRampToValueAtTime( 0, now + crossfade );
		for ( const timer of chain.timers ) clearTimeout( timer );
		setTimeout( () => {

			for ( const node of chain.nodes ) {

				try {

					if ( typeof node.stop === 'function' ) node.stop();
					node.disconnect();

				} catch ( error ) {

					// 已经停过的源再 stop 会抛，忽略
				}

			}

		}, ( crossfade + 0.2 ) * 1000 );

	}

	function playScene( key ) {

		if ( ! context ) return;
		if ( current && current.key === key ) return;
		const previous = current;
		current = buildChain( key );
		if ( previous ) fadeOutAndStop( previous );
		if ( key === 'overture' ) oarsOn = true;
		if ( current ) {

			const now = context.currentTime;
			current.gain.gain.setValueAtTime( 0, now );
			current.gain.gain.linearRampToValueAtTime( current.targetVolume, now + audioConfig.crossfade );

		}

	}

	// 开场离船以后不再划桨
	function setOars( enabled ) {

		oarsOn = Boolean( enabled );

	}

	// ===================== 轻音乐 =====================

	const noteFrequency = ( semitonesFromA4 ) => 440 * Math.pow( 2, semitonesFromA4 / 12 );
	// 四个和弦（C 大调里很软的进行：Cmaj9 → Am7 → Fmaj7 → G6），每个音用离 A4 的半音数
	const chords = [ [ - 21, - 17, - 14, - 10, - 7 ], [ - 24, - 17, - 12, - 9, - 5 ], [ - 28, - 19, - 16, - 12, - 8 ], [ - 26, - 19, - 14, - 10, - 7 ] ];
	// 八音盒用的五声音阶（C5 D5 E5 G5 A5 C6）
	const bellNotes = [ 3, 5, 7, 10, 12, 15 ];

	function startMusic() {

		const musicConfig = audioConfig.music;
		if ( ! musicConfig || ! context ) return;
		const now = context.currentTime;
		musicBus.gain.setValueAtTime( 0, now );
		musicBus.gain.linearRampToValueAtTime( musicConfig.volume, now + 6 );
		let chordIndex = 0;
		const chordSeconds = musicConfig.chordSeconds;
		const playChord = () => {

			if ( ! context ) return;
			const time = context.currentTime + 0.05;
			const notes = chords[ chordIndex % chords.length ];
			chordIndex ++;
			for ( const semitone of notes ) {

				for ( const detune of [ - 4, 4 ] ) {

					const voice = context.createOscillator();
					voice.type = 'triangle';
					voice.frequency.value = noteFrequency( semitone );
					voice.detune.value = detune;
					const filter = context.createBiquadFilter();
					filter.type = 'lowpass';
					filter.frequency.value = 900;
					const voiceGain = context.createGain();
					// 慢起（2.5 秒）、持续、慢收（和下一个和弦重叠 3 秒）
					voiceGain.gain.setValueAtTime( 0, time );
					voiceGain.gain.linearRampToValueAtTime( 0.06, time + 2.5 );
					voiceGain.gain.setValueAtTime( 0.06, time + chordSeconds - 0.5 );
					voiceGain.gain.linearRampToValueAtTime( 0, time + chordSeconds + 2.5 );
					voice.connect( filter );
					filter.connect( voiceGain );
					voiceGain.connect( musicBus );
					voiceGain.connect( delayInput );
					voice.start( time );
					voice.stop( time + chordSeconds + 2.6 );

				}

			}

			musicTimers.push( setTimeout( playChord, chordSeconds * 1000 ) );

		};

		const playBell = () => {

			if ( ! context ) return;
			const time = context.currentTime + 0.02;
			const semitone = bellNotes[ Math.floor( Math.random() * bellNotes.length ) ];
			for ( const [ ratio, level ] of [ [ 1, 0.11 ], [ 2, 0.025 ], [ 3.01, 0.012 ] ] ) {

				const bell = context.createOscillator();
				bell.frequency.value = noteFrequency( semitone ) * ratio;
				const bellGain = context.createGain();
				bellGain.gain.setValueAtTime( 0, time );
				bellGain.gain.linearRampToValueAtTime( level, time + 0.01 );
				bellGain.gain.exponentialRampToValueAtTime( 0.0005, time + 2.2 );
				bell.connect( bellGain );
				bellGain.connect( musicBus );
				bellGain.connect( delayInput );
				bell.start( time );
				bell.stop( time + 2.3 );

			}

			musicTimers.push( setTimeout( playBell, 2200 + Math.random() * 4500 ) );

		};

		playChord();
		musicTimers.push( setTimeout( playBell, 4000 ) );

	}

	function setMuted( value ) {

		muted = Boolean( value );
		if ( masterGain ) masterGain.gain.value = muted ? 0 : audioConfig.masterVolume;

	}

	function dispose() {

		for ( const timer of musicTimers ) clearTimeout( timer );
		musicTimers.length = 0;
		if ( current ) {

			for ( const timer of current.timers ) clearTimeout( timer );
			for ( const node of current.nodes ) {

				try {

					if ( typeof node.stop === 'function' ) node.stop();
					node.disconnect();

				} catch ( error ) {

					// 忽略重复 stop
				}

			}

			current = null;

		}

		if ( context ) {

			context.close().catch( () => {} );
			context = null;

		}

	}

	return { unlock, playScene, setOars, setMuted, dispose, isReady: () => context !== null };

}
