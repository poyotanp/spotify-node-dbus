const util = require('util');
const {promisify} = require('util');
const applescript = require('applescript');
const dbus = require("dbus-native");

const readDBusProp = async (dbusInterface, propName) => {
    let arr = await promisify(dbusInterface.$readProp).bind(dbusInterface)(propName);
    if (typeof arr !== "object") return arr;
    let obj = {};
    arr.forEach(([key, value]) => {
        obj[key] = value[1][0];
    });
    return obj;
};

const writeDBusProp = async (dbusInterface, propName, value) => {
    return await promisify(dbusInterface.$writeProp).bind(dbusInterface)(propName, value);
}

async function getDBusTrackId(dbusInterface) {
    let metadata = await readDBusProp(dbusInterface, "Metadata");
    return metadata["mpris:trackid"].replace("/com/spotify/track/", "spotify:track:");
}

const methods = {
    state: {
        apple_file: "get_state.applescript",
        dbus: async (s) => {
            let position = await readDBusProp(s, "Position");
            let volume = await readDBusProp(s, "Volume");
            let state = await readDBusProp(s, "PlaybackStatus");
            return {
                track_id: await getDBusTrackId(s),
                volume,
                position: position / 1000000,
                state: state.toLowerCase()
            };
        }
    },
    track: {
        apple_file: "get_track.applescript",
        dbus: async (s) => {
            let metadata = await readDBusProp(s, "Metadata");
            let trackId = await getDBusTrackId(s);
            return {
                artist: metadata["xesam:artist"][0],
                album: metadata["xesam:album"],
                disc_number: metadata["xesam:disc_number"],
                duration: metadata["mpris:length"] / 1000000,
                played_count: 0, //Not supported
                track_number: metadata["xesam:trackNumber"],
                starred: false, //Not supported
                popularity: 0, //Not supported
                id: trackId,
                name: metadata["xesam:title"],
                album_artist: metadata["xesam:albumArtist"],
                artwork_url: metadata["mpris:artUrl"],
                spotify_url: trackId
            };
        }
    },
    volumeUp: {
        apple_file: "volume_up.applescript",
        dbus: async s => await writeDBusProp(s, "Volume", await readDBusProp(s, "Volume") + 0.1)
    },
    volumeDown: {
        apple_file: "volume_down.applescript",
        dbus: async s => await writeDBusProp(s, "Volume", await readDBusProp(s, "Volume") - 0.1)
    },
    setVolume: {
        apple: "tell application \"Spotify\" to set sound volume to %s",
        dbus: (s, args) => writeDBusProp(s, "Volume", args[0] / 100)
    },
    play: {
        apple: "tell application \"Spotify\" to play",
        dbus: s => promisify(s.Play).bind(s)()
    },
    playTrack: {
        apple: "tell application \"Spotify\" to play track \"%s\"",
        dbus: (s, args) => promisify(s.OpenUri).bind(s)(args[0])
    },
    playTrackInContext: {
        apple: "tell application \"Spotify\" to play track \"%s\" in context \"%s\"",
        //TODO: Is it possible to play in album?
        dbus: (s, args) => promisify(s.OpenUri).bind(s)(args[0])
    },
    playPause: {
        apple: "tell application \"Spotify\" to playpause",
        dbus: s => promisify(s.PlayPause).bind(s)()
    },
    pause: {
        apple: "tell application \"Spotify\" to pause",
        dbus: s => promisify(s.Pause).bind(s)()
    },
    next: {
        apple: "tell application \"Spotify\" to next track",
        dbus: s => promisify(s.Next).bind(s)()
    },
    previous: {
        apple: "tell application \"Spotify\" to previous track",
        dbus: s => promisify(s.Previous).bind(s)()
    },
    jumpTo: { //SetPosition did not work.
        apple: "tell application \"Spotify\" to set player position to %s",
        dbus: async (s, args) => {
            let position = await readDBusProp(s, "Position");
            return promisify(s.Seek).bind(s)((args[0] * 1000000) - position);
        }
    },
    isRunning: {
        apple: "get running of application \"Spotify\""
    },
    isRepeating: {
        apple: "tell application \"Spotify\" to return repeating",
        dbus: async s => await readDBusProp(s, "LoopStatus") !== "None"
    },
    isShuffling: {
        apple: "tell application \"Spotify\" to return shuffling",
        dbus: s => readDBusProp(s, "Shuffle")
    },
    setRepeating: {
        apple: "tell application \"Spotify\" to set repeating to %s",
        dbus: (s, args) => writeDBusProp(s, "LoopStatus", args[0] ? "Playlist" : "None")
    },
    setShuffling: {
        apple: "tell application \"Spotify\" to set shuffling to %s",
        dbus: (s, args) => writeDBusProp(s, "Shuffle", args[0])
    },
    toggleRepeating: {
        apple_file: "toggle_repeating.applescript",
        dbus: async (s) => {
            let repeating = await readDBusProp(s, "LoopStatus") !== "None";
            return writeDBusProp(s, "LoopStatus", !repeating ? "Playlist" : "None");
        }
    },
    toggleShuffling: {
        apple_file: "toggle_shuffling.applescript",
        dbus: async (s) => {
            let shuffling = await readDBusProp(s, "Shuffle");
            return writeDBusProp(s, "Shuffle", !shuffling);
        }
    }
};

// Apple script execution
// ----------------------------------------------------------------------------

let scriptsPath = __dirname + '/scripts/';

let execScript = function (scriptName, params, callback) {
    if (arguments.length === 2 && typeof params === 'function') {
        // second argument is the callback
        callback = params;
        params = undefined;
    }

    // applescript lib needs a callback, but callback is not always useful
    if (!callback) callback = function () {
    };

    if (typeof params !== 'undefined' && !Array.isArray(params)) {
        params = [params];
    }

    let script = methods[scriptName];
    if (process.platform === "darwin") {
        if (script.apple) {
            if (typeof params !== 'undefined') script = util.format.apply(util, [script].concat(params));
            return applescript.execString(script, callback);
        } else if (script.apple_file) {
            return applescript.execFile(scriptsPath + script.apple_file, callback);
        }
    } else {
        if (scriptName !== "isRunning" && !script.dbus) throw new Error("Not Implemented");
        (async function () {
            try {
                const sessionBus = dbus.sessionBus();
                const service = sessionBus.getService(
                    "org.mpris.MediaPlayer2.spotify"
                );
                const spotifyDBusInterface = await promisify(service.getInterface).bind(service)(
                    "/org/mpris/MediaPlayer2",
                    "org.mpris.MediaPlayer2.Player"
                );
                if (scriptName === "isRunning") {
                    return callback(null, true);
                }
                try {
                    let result = await script.dbus(spotifyDBusInterface, params);
                    callback(null, JSON.stringify(result));
                } catch (e) {
                    console.error(e);
                    callback(e, null);
                }
            } catch {
                if (scriptName === "isRunning") {
                    callback(null, false);
                }
            }
        })();
    }
};

var createJSONResponseHandler = function (callback, flag) {
    if (!callback) return null;
    return function (error, result) {
        if (!error) {
            try {
                result = JSON.parse(result);
            } catch (e) {
                console.log(flag, result);
                return callback(e);
            }
            return callback(null, result);
        } else {
            return callback(error);
        }
    };
};

var createBooleanResponseHandler = function (callback) {
    return function (error, response) {
        if (!error) {
            return callback(null, response === 'true');
        } else {
            return callback(error);
        }
    }
};

// API
// ----------------------------------------------------------------------------

// Play track

exports.playTrack = function (track, callback) {
    return execScript('playTrack', track, callback);
};

exports.playTrackInContext = function (track, context, callback) {
    return execScript('playTrackInContext', [track, context], callback);
};

// Playback control

exports.play = function (callback) {
    return execScript('play', callback);
};

exports.pause = function (callback) {
    return execScript('pause', callback);
};

exports.playPause = function (callback) {
    return execScript('playPause', callback);
};

exports.next = function (callback) {
    return execScript('next', callback);
};

exports.previous = function (callback) {
    return execScript('previous', callback);
};

exports.jumpTo = function (position, callback) {
    return execScript('jumpTo', position, callback);
};

exports.setRepeating = function (repeating, callback) {
    return execScript('setRepeating', repeating, callback);
};

exports.setShuffling = function (shuffling, callback) {
    return execScript('setShuffling', shuffling, callback);
};

exports.toggleRepeating = function (callback) {
    return execScript('toggleRepeating', callback);
};

exports.toggleShuffling = function (callback) {
    return execScript('toggleShuffling', callback);
};

// Volume control

var mutedVolume = null;

exports.volumeUp = function (callback) {
    mutedVolume = null;
    return execScript('volumeUp', callback);
};

exports.volumeDown = function (callback) {
    mutedVolume = null;
    return execScript('volumeDown', callback);
};

exports.setVolume = function (volume, callback) {
    mutedVolume = null;
    return execScript('setVolume', volume, callback);
};

exports.muteVolume = function (callback) {
    return execScript('state', createJSONResponseHandler(function (err, state) {
        exports.setVolume(0, callback);
        mutedVolume = state.volume;
    }));
};

exports.unmuteVolume = function (callback) {
    if (mutedVolume !== null) {
        return exports.setVolume(mutedVolume, callback);
    }
};

// State retrieval

exports.getTrack = function (callback) {
    return execScript('track', createJSONResponseHandler(callback, 'track'));
};

exports.getState = function (callback) {
    return execScript('state', createJSONResponseHandler(callback, 'state'));
};

exports.isRunning = function (callback) {
    return execScript('isRunning', createBooleanResponseHandler(callback));
};

exports.isRepeating = function (callback) {
    return execScript('isRepeating', createBooleanResponseHandler(callback));
};

exports.isShuffling = function (callback) {
    return execScript('isShuffling', createBooleanResponseHandler(callback));
};

exports.promises = {
    playTrack: promisify(exports.playTrack),
    playTrackInContext: promisify(exports.playTrackInContext),
    play: promisify(exports.play),
    pause: promisify(exports.pause),
    playPause: promisify(exports.playPause),
    next: promisify(exports.next),
    previous: promisify(exports.previous),
    jumpTo: promisify(exports.jumpTo),
    setRepeating: promisify(exports.setRepeating),
    setShuffling: promisify(exports.setShuffling),
    toggleRepeating: promisify(exports.toggleRepeating),
    toggleShuffling: promisify(exports.toggleShuffling),
    volumeUp: promisify(exports.volumeUp),
    volumeDown: promisify(exports.volumeDown),
    setVolume: promisify(exports.setVolume),
    muteVolume: promisify(exports.muteVolume),
    unmuteVolume: promisify(exports.unmuteVolume),
    getTrack: promisify(exports.getTrack),
    getState: promisify(exports.getState),
    isRunning: promisify(exports.isRunning),
    isRepeating: promisify(exports.isRepeating),
    isShuffling: promisify(exports.isShuffling)
};