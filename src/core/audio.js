// 音频：阶段 0 没有素材，全部用 Web Audio 程序化合成（滤波噪声做风和海浪）。契约见 design-stage0.md 第 8 节。
// 开场点击之前不建 AudioContext、不出声；场景切换交叉淡入淡出。

export function createAudio( ctx ) {

	const audioConfig = ctx.config.audio;

	let context = null;
	let masterGain = null;
	let noiseBuffer = null;
	let current = null;         // 当前场景的链路 { key, nodes: [], gain, timers: [] }
	let muted = false;
	let unavailable = false;

	function makeNoiseBuffer( audioContext ) {

		// 2 秒白噪声循环，够长就听不出接缝
		const seconds = 2;
		const length = Math.floor( audioContext.sampleRate * seconds );
		const buffer = audioContext.createBuffer( 1, length, audioContext.sampleRate );
		const data = buffer.getChannelData( 0 );
		for ( let i = 0; i < length; i ++ ) {

			data[ i ] = Math.random() * 2 - 1;

		}

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
		noiseBuffer = makeNoiseBuffer( context );

		// resume 必须在用户手势里同步调用；返回的 Promise 不用等
		context.resume().then( () => {

			console.log( '音频：已解锁，状态 ' + context.state );

		} ).catch( ( error ) => {

			console.warn( '音频：resume 失败：', error );

		} );

	}

	// 建一条场景链路：噪声 → 低通 → 场景音量 → 主音量；LFO 慢慢晃滤波频率和音量
	function buildChain( key ) {

		const sceneAudio = audioConfig.scenes[ key ];
		if ( ! sceneAudio ) {

			console.warn( `音频：config.audio.scenes 里没有 ${ key }，这个场景静音` );
			return null;

		}

		const now = context.currentTime;
		const nodes = [];
		const timers = [];

		const source = context.createBufferSource();
		source.buffer = noiseBuffer;
		source.loop = true;

		const filter = context.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.value = sceneAudio.cutoff;
		filter.Q.value = 0.7;

		const gain = context.createGain();
		gain.gain.value = 0;

		source.connect( filter );
		filter.connect( gain );
		gain.connect( masterGain );
		source.start( now );
		nodes.push( source, filter, gain );

		// LFO 1：晃滤波频率，像风一阵一阵
		const lfo = context.createOscillator();
		lfo.type = 'sine';
		lfo.frequency.value = sceneAudio.lfoRate;
		const lfoDepth = context.createGain();
		lfoDepth.gain.value = sceneAudio.cutoff * 0.45;
		lfo.connect( lfoDepth );
		lfoDepth.connect( filter.frequency );
		lfo.start( now );
		nodes.push( lfo, lfoDepth );

		// LFO 2：晃音量；海浪用更深更慢的调制
		const isWaves = sceneAudio.kind === 'waves';
		const volumeLfo = context.createOscillator();
		volumeLfo.type = 'sine';
		volumeLfo.frequency.value = isWaves ? sceneAudio.lfoRate * 0.6 : sceneAudio.lfoRate * 1.7;
		const volumeDepth = context.createGain();
		volumeDepth.gain.value = sceneAudio.volume * ( isWaves ? 0.6 : 0.25 );
		volumeLfo.connect( volumeDepth );
		volumeDepth.connect( gain.gain );
		volumeLfo.start( now );
		nodes.push( volumeLfo, volumeDepth );

		// 夜晚：每 2~5 秒一声短促的高频"虫鸣"
		if ( sceneAudio.kind === 'night' ) {

			const chirp = () => {

				if ( ! context || current === null || current.key !== key ) return;
				const start = context.currentTime;
				const osc = context.createOscillator();
				osc.type = 'sine';
				osc.frequency.value = 3800 + Math.random() * 1200;
				const chirpGain = context.createGain();
				chirpGain.gain.setValueAtTime( 0, start );
				chirpGain.gain.linearRampToValueAtTime( sceneAudio.volume * 0.5, start + 0.03 );
				chirpGain.gain.linearRampToValueAtTime( 0, start + 0.18 );
				osc.connect( chirpGain );
				chirpGain.connect( masterGain );
				osc.start( start );
				osc.stop( start + 0.2 );
				timers.push( setTimeout( chirp, 2000 + Math.random() * 3000 ) );

			};

			timers.push( setTimeout( chirp, 1500 ) );

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

		if ( current ) {

			const now = context.currentTime;
			current.gain.gain.setValueAtTime( 0, now );
			current.gain.gain.linearRampToValueAtTime( current.targetVolume, now + audioConfig.crossfade );

		}

	}

	function setMuted( value ) {

		muted = Boolean( value );
		if ( masterGain ) masterGain.gain.value = muted ? 0 : audioConfig.masterVolume;

	}

	function dispose() {

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

	return { unlock, playScene, setMuted, dispose, isReady: () => context !== null };

}
