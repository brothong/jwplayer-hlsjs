'use strict';
var EventEmitter = require('eventemitter3');
var E = module.exports = HlsProv;
var callback, provider_attached = false, provider_disabled = false;

// XXX arik: protect against exceptions in api. currently jwplayer will be
// stuck + add test
function HlsProv(id){
    var jwe = window.jwplayer.events;
    function empty_fn(name){ return function(){}; }
    var _this = this;
    if (callback)
        callback(this);
    this.hls_restore_pos = function(){
        var new_pos = this.hls_queued.seek;
        var old_pos = video.currentTime;
        if (hls.streamController.state == 'STOPPED')
        {
            // XXX pavelki: hack to use our start position
            hls.streamController.startPosition = 0;
            hls.streamController.startLoad(new_pos||0);
        }
        if (!new_pos)
            return;
        this._in_seek = true;
        video.currentTime = new_pos;
        this.trigger(jwe.JWPLAYER_MEDIA_SEEK, {position: old_pos,
            offset: new_pos});
        // XXX pavelki: hack to override W3 algorithm of media
        // seeking: when video element has HAVE_NOTHING state,
        // seeking event doesn't fire and loading doesn't start
        if (!video.readyState)
            video.dispatchEvent(new Event('seeking'));
        this.hls_queued.seek = 0;
    };
    function hls_play(){
        if (!(_this.hls_queued.play = _this.hls_state!='ready'))
        {
            _this.hls_restore_pos();
            video.play();
        }
    }
    function hls_load(src){
        if (!src)
            return;
        if (_this.hls_state=='ready')
            _this.hls_state = 'idle';
        _this.level_cb = function(){
            hls.off(window.Hls.Events.LEVEL_LOADED, _this.level_cb);
            _this.level_cb = undefined;
            _this.hls_state = 'ready';
            if (_this.hls_queued.play)
                hls_play();
            _this.trigger(jwe.JWPLAYER_MEDIA_BUFFER_FULL);
        };
        hls.on(window.Hls.Events.LEVEL_LOADED, _this.level_cb);
        hls.loadSource(src);
        if (!hls.media)
            _this.attachMedia();
    }
    function get_default_src(sources){
        return sources &&
            sources.find(function(s){ return s.default; }) || sources[0];
    }
    // XXX marka: jwplayer inherits provider from DefaultProvider, so it will
    // override our inheritance from EventEmitter, do it manually
    this.events = new EventEmitter();
    this.addEventListener = this.on = this.events.on.bind(this.events);
    this.once = this.events.once.bind(this.events);
    this.removeEventListener = this.off = this.events.off.bind(this.events);
    this.trigger = this.emit = function(e){
        var args = [].slice.call(arguments);
        _this.events.emit.apply(this.events, args);
        if (e!='all')
        {
            args.unshift('all');
            _this.events.emit.apply(this.events, args);
        }
    };
    this.removeAllListeners = function(e){
        this.events.removeAllListeners(e); };
    this.hls_queued = {play: false, seek: 0};
    this.attached = true;
    this.hls_state = 'idle';
    var element = document.getElementById(id), container;
    var video = element ? element.querySelector('video') : undefined, hls, jw;
    video = video || document.createElement('video');
    video.className = 'jw-video jw-reset';
    // XXX marka: mark html5 element to skip autodetection of dm/hls
    video.hola_dm_hls_attached = true;
    // XXX pavelki: hack to override ozee's wrong src set
    var o = video;
    while (o && !(o = Object.getPrototypeOf(o)).hasOwnProperty('src'));
    if (o)
    {
        var prop = Object.getOwnPropertyDescriptor(o, 'src');
        Object.defineProperty(video, 'src', {
            configurable: true,
            enumerable: false,
            set: function(src){
                if (src == prop.get.call(video)+'?')
                    return;
                prop.set.call(video, src);
            },
            get: prop.get,
        });
    }
    var hls_params = {debug: false};
    this.ad_count = 0;
    if (id && (jw = window.jwplayer(id)))
    {
        // XXX pavelki: counters for ad, need to make load deferred
        jw.on('adImpression', function(){
            _this.ad_count++;
        });
        jw.on('adComplete', function(){ _this.ad_count--; });
        jw.on('adSkipped', function(){ _this.ad_count--; });
        Object.assign(hls_params, jw.hola_config);
    }
    hls = new window.Hls(hls_params);
    if (jw)
        jw.hls = hls;
    var _buffered, _duration, _position;
    function get_seekable_end(){
        var i, end, len = video.seekable ? video.seekable.length : 0;
        for (end = 0, i = 0; i<len; i++)
            end = Math.max(end, video.seekable.end(i));
        return end;
    }
    function get_duration(){
        var duration = video.duration, end = get_seekable_end();
        if (duration==Infinity && end)
        {
            var seekable_dur = end-video.seekable.start(0);
            if (seekable_dur!=Infinity && seekable_dur>120)
                duration = -seekable_dur;
        }
        return duration;
    }
    function get_duration_inf(){
        return is_live() ? 1/0 : get_duration();
    }
    function is_live(){
        var live, sc;
        try {
            sc = hls.streamController;
            live = sc.levels[sc.currentLevel].details.live;
        } catch(e){}
        return live;
    }
    function get_buffered(){
        var buf = video.buffered, dur = video.duration;
        if (!buf || !buf.length || dur<=0 || dur==Infinity)
            return 0;
        return Math.min(buf.end(buf.length-1)/dur, 1.0);
    }
    function set_buffered(buffered, pos, duration){
        if (buffered==_buffered && duration==_duration)
            return;
        _buffered = buffered;
        _this.trigger(jwe.JWPLAYER_MEDIA_BUFFER, {bufferPercent: buffered*100,
            position: pos, duration: get_duration_inf()});
    }
    var video_listeners = {
        durationchange: function(){
            _duration = get_duration();
            set_buffered(get_buffered(), _position, _duration);
        },
        ended: function(){
            if (_this.state=='idle' || _this.state=='complete')
                return;
            _this.completed = true;
            _this.trigger(jwe.JWPLAYER_MEDIA_BEFORECOMPLETE);
            if (!_this.attached)
                _this.post_roll = true;
            _this.setState('complete');
            _this.completed = false;
            _this.trigger(jwe.JWPLAYER_MEDIA_COMPLETE);
        },
        error: function(){
            _this.trigger(jwe.JWPLAYER_MEDIA_ERROR, {
                message: 'Error loading media: File could not be played'});
        },
        loadstart: function(){ video.setAttribute('jw-loaded', 'started'); },
        loadeddata: function(){ video.setAttribute('jw-loaded', 'data'); },
        loadedmetadata: function(){
            if (video.muted)
            {
                video.muted = false;
                video.muted = true;
            }
            video.setAttribute('jw-loaded', 'meta');
            _duration = get_duration();
            _this.trigger(jwe.JWPLAYER_MEDIA_META, {duration:
                get_duration_inf(), height: video.videoHeight,
                width: video.videoWidth});
        },
        canplay: function(){ _this.trigger(jwe.JWPLAYER_MEDIA_BUFFER_FULL); },
        playing: function(){
            _this.setState('playing');
            if (!video.hasAttribute('jw-played'))
                video.setAttribute('jw-played', '');
            _this.trigger(jwe.JWPLAYER_PROVIDER_FIRST_FRAME, {});
        },
        pause: function(){
            if (_this.state=='complete' || video.currentTime==video.duration)
                return;
            _this.setState('paused');
        },
        seeking: function(){
            if (!_this._in_seek)
            {
                _this._in_seek = true;
                _this.trigger(jwe.JWPLAYER_MEDIA_SEEK, {position: _position,
                    offset: video.currentTime});
            }
        },
        seeked: function(){
            _this._in_seek = false;
            _this.trigger(jwe.JWPLAYER_MEDIA_SEEKED);
        },
        progress: function(){
            set_buffered(get_buffered(), _position, _duration); },
        timeupdate: function(){
            _duration = get_duration();
            _position = _duration<0 ? -(get_seekable_end()-video.currentTime) :
                video.currentTime;
            set_buffered(get_buffered(), _position, _duration);
            if (_this.state=='playing')
            {
                _this.trigger(jwe.JWPLAYER_MEDIA_TIME, {position: _position,
                    duration: get_duration_inf()});
            }
        },
    };
    function wrap_gen(e){
        return function(){
            if (!_this.attached)
                return;
            video_listeners[e]();
        };
    }
    for (var e in video_listeners)
        video.addEventListener(e, wrap_gen(e), false);
    function scaled_number(num){
        if (num===undefined)
            return '';
        if (!num)
            return '0';
        var k = 1024;
        var sizes = ['', 'K', 'M', 'G', 'T', 'P'];
        var i = Math.floor(Math.log(num)/Math.log(k));
        num /= Math.pow(k, i);
        if (num<0.001)
            return '0';
        if (num>=k-1)
            num = Math.trunc(num);
        var str = num.toFixed(num<1 ? 3 : num<10 ? 2 : num<100 ? 1 : 0);
        return str.replace(/\.0*$/, '')+sizes[i];
    }
    // XXX yurij: duplicate from videojs5-hlsjs to avoid deps
    function level_label(level){
        if (level.height)
            return level.height+'p';
        if (level.width)
            return Math.round(level.width*9/16)+'p';
        if (level.bitrate)
            return scaled_number(level.bitrate)+'bps';
        return 0;
    }
    function get_levels(){
        // level 0 mimics native jw's hls provider behavior
        var levels = [{bitrate: 1, width: 1, height: 1, label: 'Auto'}];
        hls.levels.forEach(function(level){
            levels.push({bitrate: level.bitrate, height: level.height,
                label: level_label(level), width: level.width});
        });
        return levels;
    }
    hls.on(window.Hls.Events.MANIFEST_LOADED, function(){
        _this.trigger(jwe.JWPLAYER_MEDIA_LEVELS, {
            currentQuality: hls.autoLevelEnabled ? 0 : hls.currentLevel+1,
            levels: get_levels()
        });
    });
    hls.on(window.Hls.Events.LEVEL_SWITCH, function(e, data){
        _this.trigger(jwe.JWPLAYER_MEDIA_LEVEL_CHANGED, {
            // level 0 is dummy for 'Auto' option in jwplayer's UI
            currentQuality: hls.manual_level==-1 ? 0 : data.level+1,
            levels: get_levels()
        });
    });
    this.init = function(item){ video.setAttribute('jw-loaded', 'init'); };
    this.load = function(item){
        if (!this.attached)
            return;
        var newsource = get_default_src(item.sources).file;
        var video_state = video.getAttribute('jw-loaded');
        var hq = this.hls_queued;
        this.setState('loading');
        hq.seek = Math.max(item.starttime-(hq.rw_sec||0), 0);
        if (this.hls_state!='ready' || (this.source||'') != newsource ||
            ['init', 'started'].includes(video_state))
        {
            video.load();
            hls.stopLoad();
            hls_load(this.source = newsource);
            video.setAttribute('jw-loaded', 'init');
        }
        else
            hls_play();
    };
    this.play = function(){ hls_play(); };
    this.pause = function(){
        video.pause();
        _this.setState('paused');
    };
    this.stop = function(){
        hls.stopLoad();
        _this.setState('idle');
    };
    this.volume = function(vol){ video.volume = Math.min(vol/100, 1.0); };
    this.mute = function(state){ video.muted = !!state; };
    this.seek = function(pos){
        this._in_seek = true;
        if (this.hls_state=='ready')
        {
            var sv = video.currentTime;
            video.currentTime = pos;
            this.trigger(jwe.JWPLAYER_MEDIA_SEEK, {position: sv, offset: pos});
        }
        else
            this.hls_queued.seek = pos;
    };
    // XXX arik: todo, without it video resize will be wrong.
    // eg. http://www.ozee.com/shows/muddha-mandaram#hola_mode=cdn&hola_zone=ozee_hap
    this.resize = function(width, height, stretching){};
    this.remove = function(){
        this.in_container = false;
        hls.stopLoad();
        this.source = undefined;
        if (container === video.parentNode)
            container.removeChild(video);
    };
    this.destroy = function(){
        for (var e in video_listeners)
            video.removeEventListener(e, video_listeners[e], false);
        this.removeAllListeners();
    };
    this.setVisibility = function(state){
        container.style.visibility = state ? 'visible' : '';
        container.style.opacity = state ? 1 : 0;
    };
    this.setFullscreen = function(){ return false; };
    this.getFullscreen = empty_fn('getFullscreen');
    this.getContainer = function(){ return container; };
    this.setContainer = function(element){
        container = element;
        container.appendChild(video);
        this.in_container = true;
    };
    hls.manual_level = -1;
    this.setCurrentQuality = function(level){
        if (level == hls.manual_level+1)
            return;
        hls.manual_level = level-1;
        if (!hls.hola_adaptive)
            hls.loadLevel = hls.manual_level;
        _this.trigger(jwe.JWPLAYER_MEDIA_LEVEL_CHANGED,
            {currentQuality: level, levels: get_levels()});
    };
    this.getName = function(){ return {name: 'dm/hls'}; };
    this.get_position = function(){ return video.currentTime; };
    this.getQualityLevels = function(){ return get_levels(); };
    this.getCurrentQuality = function(){ return hls.loadLevel+1; };
    this.getAudioTracks = empty_fn('getAudioTracks');
    this.getCurrentAudioTrack = empty_fn('getCurrentAudioTrack');
    this.setCurrentAudioTrack = empty_fn('setCurrentAudioTrack');
    this.checkComplete = function(){ return !!this.completed; };
    this.setControls = empty_fn('setControls');
    this.attachMedia = function(){
        if (this.ad_count && hls_params.debug)
            hls_params.debug.log('jwprovider attach inside ad '+this.ad_count);
        this.attached = true;
        // prevent hls attach after a postroll and playback completes
        if (this.post_roll)
        {
            this.hls_state = 'idle';
            return this.post_roll = undefined;
        }
        hls.attachMedia(video);
        var video_state = video.getAttribute('jw-loaded');
        if (video_state && !['init', 'started'].includes(video_state))
            this.setState('ready');
    };
    this.detachMedia = function(){
        hls.trigger(window.Hls.Events.BUFFER_RESET);
        hls.detachMedia();
        if (this.level_cb)
        {
            hls.off(window.Hls.Events.LEVEL_LOADED, this.level_cb);
            this.level_cb = undefined;
        }
        // XXX pavelki: hack to remove pending segments
        delete hls.bufferController.segments;
        this.attached = false;
        this.setState('paused');
        return video;
    };
    this.setState = function(state){
        var oldState = this.state||'idle';
        this.state = state;
        if (state==oldState)
            return;
        this.trigger(jwe.JWPLAYER_PLAYER_STATE, {newstate: state});
    };
    this.sendMediaType = function(levels){
        var is_audio = ['oga', 'aac', 'mp3', 'mpeg', 'vorbis']
            .includes(levels[0].type);
        this.trigger(jwe.JWPLAYER_MEDIA_TYPE, {mediaType: is_audio ?
            'audio' : 'video'});
    };
}

E.getName = function(){ return {name: 'dm/hls'}; };

E.supports = function(src){
    return !E.disabled && src.type=='hls' && window.Hls &&
        window.Hls.isSupported(); };

E.attach = function(cb){
    provider_disabled = false;
    if (!provider_attached) 
    {
        provider_attached = true;
        callback = cb;
        // XXX arik: unregister on error/fallback
        window.jwplayer.api.registerProvider(this);
    }
};

E.detach = function(){
    // we don't remove provider from list, just set it as disabled so it will
    // return false in supports()
    provider_disabled = true;
};

E.VERSION = '__VERSION__';

return E;
