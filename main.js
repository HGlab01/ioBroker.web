/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

var express = require('express');
var fs =      require('fs');
//var Stream =  require('stream');
var utils =   require(__dirname + '/lib/utils'); // Get common adapter utils
var LE =      require(utils.controllerDir + '/lib/letsencrypt.js');

var session;// =           require('express-session');
var cookieParser;// =      require('cookie-parser');
var bodyParser;// =        require('body-parser');
var AdapterStore;// =      require(__dirname + '/../../lib/session.js')(session);
var passportSocketIo;// =  require(__dirname + "/lib/passport.socketio.js");
var password;// =          require(__dirname + '/../../lib/password.js');
var passport;// =          require('passport');
var LocalStrategy;// =     require('passport-local').Strategy;
var flash;// =             require('connect-flash'); // TODO report error to user

var webServer   = null;
var store       = null;
var secret      = 'Zgfr56gFe87jJOM'; // Will be generated by first start
var socketUrl   = '';
var cache       = {}; // cached web files
var ownSocket   = false;
var lang        = 'en';
var extensions  = {};
var bruteForce  = {};

var adapter = new utils.Adapter({
    name: 'web',
    objectChange: function (id, obj) {
        if (obj && obj.common && obj.common.webExtension && obj.native &&
            (extensions[id.substring('system.adapter.'.length)] ||
             obj.native.webInstance === '*' ||
             obj.native.webInstance === 'adapter.namespace'
            )
        ) {
            adapter.setForeignState('system.adapter.' + adapter.namespace + '.alive', false, true, function () {
                process.exit(-100);
            });
            return;
        }

        if (!ownSocket && id === adapter.config.socketio) {
            if (obj && obj.common && obj.common.enabled && obj.native) {
                socketUrl = ':' + obj.native.port;
            } else {
                socketUrl = '';
            }
        }
        if (webServer.io) webServer.io.publishAll('objectChange', id, obj);
        if (webServer.api && adapter.config.auth) webServer.api.objectChange(id, obj);
        if (id === 'system.config') {
            lang = obj && obj.common && obj.common.language ? obj.common.language : 'en';
        }

        // inform extensions
        for (var e = 0; e < extensions.length; e++) {
            try {
                if (extensions[e].obj && extensions[e].obj.objectChange) {
                    extensions[e].obj.objectChange(id, obj);
                }
            } catch (err) {
                adapter.log.error('Cannot call objectChange for "' + e + '": ' + err);
            }
        }
    },
    stateChange: function (id, state) {
        if (webServer.io) webServer.io.publishAll('stateChange', id, state);
    },
    unload: function (callback) {
        try {
            adapter.log.info('terminating http' + (webServer.settings.secure ? 's' : '') + ' server on port ' + webServer.settings.port);
            webServer.server.close();
            adapter.log.info('terminated http' + (webServer.settings.secure ? 's' : '') + ' server on port ' + webServer.settings.port);

            callback();
        } catch (e) {
            callback();
        }
    },
    ready: function () {
        // Generate secret for session manager
        adapter.getForeignObject('system.config', function (err, obj) {
            if (!err && obj) {
                if (!obj.native || !obj.native.secret) {
                    obj.native = obj.native || {};
                    require('crypto').randomBytes(24, function (ex, buf) {
                        secret = buf.toString('hex');
                        adapter.extendForeignObject('system.config', {native: {secret: secret}});
                        main();
                    });
                } else {
                    secret = obj.native.secret;
                    main();
                }
            } else {
                adapter.logger.error('Cannot find object system.config');
            }
        });

        // information about connected socket.io adapter
        if (adapter.config.socketio && adapter.config.socketio.match(/^system\.adapter\./)) {
            adapter.getForeignObject(adapter.config.socketio, function (err, obj) {
                if (obj && obj.common && obj.common.enabled && obj.native) socketUrl = ':' + obj.native.port;
            });
            // Listen for changes
            adapter.subscribeForeignObjects(adapter.config.socketio);
        } else {
            socketUrl = adapter.config.socketio;
            ownSocket = (socketUrl !== 'none');
        }

        // Read language
        adapter.getForeignObject('system.config', function (err, data) {
            if (data && data.common) lang = data.common.language || 'en';
        });
    }
});

function getExtensions(callback) {
    adapter.objects.getObjectView('system', 'instance', null, function (err, doc) {
        if (err) {
            if (callback) callback (err, []);
        } else {
            if (doc.rows.length === 0) {
                if (callback) callback (null, []);
            } else {
                var res = [];
                for (var i = 0; i < doc.rows.length; i++) {
                    var instance = doc.rows[i].value;
                    if (instance && instance.common && (instance.common.enabled || instance.common.onlyWWW) &&
                        instance.common.webExtension &&
                        (instance.native.webInstance === adapter.namespace || instance.native.webInstance === '*')) {
                        res.push(doc.rows[i].value);
                    }
                }
                if (callback) callback (null, res);
            }
        }
    });
}

function main() {
    getExtensions(function (err, ext) {
        if (err) adapter.log.error('Cannot read extensions: ' + err);
        if (ext) {
            for (var e = 0; e < ext.length; e++) {
                if (ext[e] && ext[e].common) {
                    var instance = ext[e]._id.substring('system.adapter.'.length);
                    var name = instance.split('.')[0];

                    extensions[instance] = {
                        path: name + '/' + ext[e].common.webExtension,
                        config: ext[e]
                    };
                }
            }
        }

        if (adapter.config.secure) {
            // Load certificates
            adapter.getCertificates(function (err, certificates, leConfig) {
                adapter.config.certificates = certificates;
                adapter.config.leConfig     = leConfig;
                webServer = initWebServer(adapter.config);
            });
        } else {
            webServer = initWebServer(adapter.config);
        }
        // monitor extensions and pro keys
        adapter.subscribeForeignObjects('system.adapter.*');
    });
}

function readDirs(dirs, cb, result) {
    result = result || [];
    if (!dirs || !dirs.length) {
        return cb && cb(result);
    }
    var dir = dirs.shift();
    adapter.readDir(dir, '', function (err, files) {
        if (!err && files && files.length) {
            for (var f = 0; f < files.length; f++) {
                if (files[f].file.match(/\.html$/)) {
                    result.push(dir + '/' + files[f].file);
                }
            }
        }
        setTimeout(function () {
            readDirs(dirs, cb, result);
        }, 0);
    });
}

var specialScreen = [
    {"link": "flot/edit.html",      "name": "flot editor",  "img": "flot.admin/flot.png",       "color": "gray",  "order": 4},
    {"link": "mobile/index.html",   "name": "mobile",       "img": "mobile.admin/mobile.png",   "color": "black", "order": 3},
    {"link": "vis/edit.html",       "name": "vis editor",   "img": "vis/img/faviconEdit.png",   "color": "green", "order": 2},
    {"link": "vis/index.html",      "name": "vis",          "img": "vis/img/favicon.png",       "color": "blue",  "order": 1}
];

var indexHtml;

function getLinkVar(_var, obj, attr, link) {
    if (attr === 'protocol') attr = 'secure';

    if (_var === 'ip') {
        link = link.replace('%' + _var + '%', '$host$');
    } else
    if (_var === 'instance') {
        var instance = obj._id.split('.').pop();
        link = link.replace('%' + _var + '%', instance);
    } else {
        if (obj) {
            if (attr.match(/^native_/)) attr = attr.substring(7);

            var val = obj.native[attr];
            if (_var === 'bind' && (!val || val === '0.0.0.0')) val = '$host$';

            if (attr === 'secure') {
                link = link.replace('%' + _var + '%', val ? 'https' : 'http');
            } else {
                if (link.indexOf('%' + _var + '%') === -1) {
                    link = link.replace('%native_' + _var + '%', val);
                } else {
                    link = link.replace('%' + _var + '%', val);
                }
            }
        } else {
            if (attr === 'secure') {
                link = link.replace('%' + _var + '%', 'http');
            } else {
                if (link.indexOf('%' + _var + '%') === -1) {
                    link = link.replace('%native_' + _var + '%', '');
                } else {
                    link = link.replace('%' + _var + '%', '');
                }
            }
        }
    }
    return link;
}

function resolveLink(link, instanceObj, instancesMap) {
    var vars = link.match(/%(\w+)%/g);
    var _var;
    var v;
    var parts;
    if (vars) {
        // first replace simple patterns
        for (v = vars.length - 1; v >= 0; v--) {
            _var = vars[v];
            _var = _var.replace(/%/g, '');

            parts = _var.split('_');
            // like "port"
            if (_var.match(/^native_/)) {
                link = getLinkVar(_var, instanceObj, _var, link);
                vars.splice(v, 1);
            } else
            if (parts.length === 1) {
                link = getLinkVar(_var, instanceObj, parts[0], link);
                vars.splice(v, 1);
            } else
            // like "web.0_port"
            if (parts[0].match(/\.[0-9]+$/)) {
                link = getLinkVar(_var, instancesMap['system.adapter.' + parts[0]], parts[1], link);
                vars.splice(v, 1);
            }
        }
        var links = {};
        var instances;
        var adptr = parts[0];
        // process web_port
        for (v = 0; v < vars.length; v++) {
            _var = vars[v];
            _var = _var.replace(/%/g, '');
            if (_var.match(/^native_/)) _var = _var.substring(7);

            parts = _var.split('_');
            if (!instances) {
                instances = [];
                for (var inst = 0; inst < 10; inst++) {
                    if (that.main.objects['system.adapter.' + adptr + '.' + inst]) instances.push(inst);
                }
            }

            for (var i = 0; i < instances.length; i++) {
                links[adptr + '.' + i] = {
                    instance: adptr + '.' + i,
                    link: getLinkVar(_var, instancesMap['system.adapter.' + adptr + '.' + i], parts[1], links[adptr + '.' + i] ? links[adptr + '.' + i].link : link)
                };
            }
        }
        var result;
        if (instances) {
            result = [];
            var count = 0;
            var firtsLink = '';
            for (var d in links) {
                result[links[d].instance] = links[d].link;
                if (!firtsLink) firtsLink = links[d].link;
                count++;
            }
            if (count < 2) {
                link = firtsLink;
                result = null;
            }
        }
    }
    return result || link;
}

function replaceInLink(link, instanceObj, instances) {
    if (typeof link === 'object') {
        var links = JSON.parse(JSON.stringify(link));
        var first;
        for (var v in links) {
            if (links.hasOwnProperty(v)) {
                links[v] = resolveLink(links[v], instanceObj, instances);
                if (!first) first = links[v];
            }
        }
        links.__first = first;
        return links;
    } else {
        return resolveLink(link, instanceObj, instances);
    }
}

function getListOfAllAdapters(callback) {
    try {
        // read all instances
        adapter.objects.getObjectView('system', 'instance', {}, function (err, instances) {
            adapter.objects.getObjectView('system', 'adapter', {}, function (err, adapters) {
                var list = [];
                var a;
                var mapInstance = {};
                for (var r = 0; r < instances.rows.length; r++) {
                    mapInstance[instances.rows[r].id] = instances.rows[r].value;
                }
                for (a = 0; a < adapters.rows.length; a++) {
                    var obj = adapters.rows[a].value;
                    var found = '';
                    if (instances && instances.rows) {
                        found = '';
                        // find if any instance of this adapter is exists and started
                        for (var i = 0; i < instances.rows.length; i++) {
                            var id = instances.rows[i].id;
                            var ids = id.split('.');
                            ids.pop();
                            id = ids.join('.');
                            if (id === obj._id && instances.rows[i].value.common && instances.rows[i].value.common.enabled) {
                                found = instances.rows[i].id;
                                break;
                            }
                        }
                    }

                    if (found) {
                        if (obj.common.welcomeScreen || obj.common.welcomeScreenPro) {
                            if (obj.common.welcomeScreen) {
                                if (obj.common.welcomeScreen instanceof Array) {
                                    for (var w = 0; w < obj.common.welcomeScreen.length; w++) {
                                        // temporary disabled
                                        if (obj.common.welcomeScreen[w].name === 'vis editor') {
                                            continue;
                                        }
                                        if (obj.common.welcomeScreen[w].localLink && typeof obj.common.welcomeScreen[w].localLink === 'boolean') {
                                            obj.common.welcomeScreen[w].localLink = obj.common.localLink;
                                        }
                                        if (obj.common.welcomeScreen[w].localLink) {
                                            obj.common.welcomeScreen[w].id = found;
                                        }
                                        list.push(obj.common.welcomeScreen[w]);
                                    }
                                } else {
                                    if (obj.common.welcomeScreen.localLink && typeof obj.common.welcomeScreen.localLink === 'boolean') {
                                        obj.common.welcomeScreen.localLink = obj.common.localLink;
                                    }
                                    if (obj.common.welcomeScreen.localLink) {
                                        obj.common.welcomeScreen.id = found;
                                    }
                                    list.push(obj.common.welcomeScreen);
                                }
                            }
                            if (obj.common.welcomeScreenPro) {
                                if (obj.common.welcomeScreenPro instanceof Array) {
                                    for (var ww = 0; ww < obj.common.welcomeScreenPro.length; ww++) {
                                        var tile = Object.assign({}, obj.common.welcomeScreenPro[ww]);
                                        tile.pro = true;
                                        if (tile.localLink && typeof tile.localLink === 'boolean') {
                                            tile.localLink = obj.common.localLink;
                                        }
                                        if (tile.localLink) {
                                            tile.id = found;
                                        }
                                        list.push(tile);
                                    }
                                } else {
                                    var tile_ = Object.assign({}, obj.common.welcomeScreenPro);
                                    tile_.pro = true;
                                    if (tile_.localLink && typeof tile_.localLink === 'boolean') {
                                        tile_.localLink = obj.common.localLink;
                                    }
                                    if (tile_.localLink) {
                                        tile_.id = found;
                                    }
                                    list.push(tile_);
                                }
                            }
                        } else{
                            for (var s = 0; s < specialScreen.length; s++) {
                                var link = specialScreen[s].link.split('/')[0];
                                if (link === obj.common.name) {
                                    list.push(specialScreen[s]);
                                }
                            }
                        }
                    }
                }

                indexHtml = /*indexHtml || */fs.readFileSync(__dirname + '/www/index.html').toString();
                list.sort(function (a, b) {
                    if (a.order === undefined && b.order === undefined) {
                        if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
                        if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
                        return 0;
                    } else if (a.order === undefined) {
                        return -1;
                    } else if (b.order === undefined) {
                        return 1;
                    } else {
                        if (a.order > b.order) return 1;
                        if (a.order < b.order) return -1;
                        if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
                        if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
                        return 0;
                    }
                });

                // calculate localLinks
                for (var t = 0; t < list.length; t++) {
                    if (list[t].localLink) {
                        list[t].localLink = resolveLink(list[t].localLink, mapInstance[list[t].id], mapInstance);
                    }
                }

                var text = 'systemLang = "' + lang + '";\n';
                text += 'list = ' + JSON.stringify(list, null, 2) + ';\n';

                // if login
                text += 'var authEnabled = ' + adapter.config.auth + ';\n';

                callback(null, indexHtml.replace('// -- PLACE THE LIST HERE --', text));
            });
        });
    } catch (e) {
        callback(e);
    }
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//    "cache":  false
//}
function initWebServer(settings) {

    var server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };
    adapter.subscribeForeignObjects('system.config');

    settings.ttl = parseInt(settings.ttl, 10) || 3600;
    if (!settings.whiteListEnabled && settings.whiteListSettings) delete settings.whiteListSettings;

    settings.defaultUser = settings.defaultUser || 'system.user.admin';
    if (!settings.defaultUser.match(/^system\.user\./)) settings.defaultUser = 'system.user.' + settings.defaultUser;

    if (settings.port) {
        if (settings.secure) {
            if (!settings.certificates) {
                return null;
            }
        }
        server.app = express();
        if (settings.auth) {
            session =          require('express-session');
            cookieParser =     require('cookie-parser');
            bodyParser =       require('body-parser');
            AdapterStore =     require(utils.controllerDir + '/lib/session.js')(session, settings.ttl);
            passportSocketIo = require('passport.socketio');
            password =         require(utils.controllerDir + '/lib/password.js');
            passport =         require('passport');
            LocalStrategy =    require('passport-local').Strategy;
            flash =            require('connect-flash'); // TODO report error to user

            store = new AdapterStore({adapter: adapter});

            passport.use(new LocalStrategy(
                function (username, password, done) {
                    if (bruteForce[username] && bruteForce[username].errors > 4) {
                        var minutes = (new Date().getTime() - bruteForce[username].time);
                        if (bruteForce[username].errors < 7) {
                            if ((new Date().getTime() - bruteForce[username].time) < 60000) {
                                minutes = 1;
                            } else {
                                minutes = 0;
                            }
                        } else
                        if (bruteForce[username].errors < 10) {
                            if ((new Date().getTime() - bruteForce[username].time) < 180000) {
                                minutes = Math.ceil((180000 - minutes) / 60000);
                            } else {
                                minutes = 0;
                            }
                        } else
                        if (bruteForce[username].errors < 15) {
                            if ((new Date().getTime() - bruteForce[username].time) < 600000) {
                                minutes = Math.ceil((600000 - minutes) / 60000);
                            } else {
                                minutes = 0;
                            }
                        } else
                        if ((new Date().getTime() - bruteForce[username].time) < 3600000) {
                            minutes = Math.ceil((3600000 - minutes) / 60000);
                        } else {
                            minutes = 0;
                        }

                        if (minutes) {
                            return done('Too many errors. Try again in ' + minutes + ' ' + (minutes === 1 ? 'minute' : 'minutes') + '.', false);
                        }
                    }
                    adapter.checkPassword(username, password, function (res) {
                        if (!res) {
                            bruteForce[username] = bruteForce[username] || {errors: 0};
                            bruteForce[username].time = new Date().getTime();
                            bruteForce[username].errors++;
                        } else if (bruteForce[username]) {
                            delete bruteForce[username];
                        }

                        if (res) {
                            return done(null, username);
                        } else {
                            return done(null, false);
                        }
                    });
                }
            ));
            passport.serializeUser(function (user, done) {
                done(null, user);
            });

            passport.deserializeUser(function (user, done) {
                done(null, user);
            });

            server.app.use(cookieParser());
            server.app.use(bodyParser.urlencoded({
                extended: true
            }));
            server.app.use(bodyParser.json());
            server.app.use(bodyParser.text());
            server.app.use(session({
                secret:            secret,
                saveUninitialized: true,
                resave:            true,
                store:             store
            }));
            server.app.use(passport.initialize());
            server.app.use(passport.session());
            server.app.use(flash());

            var autoLogonOrRedirectToLogin = function (req, res, next, redirect) {
                if (!settings.whiteListSettings) {
					if (/\.js$/.test(req.originalUrl)) {
						// return always valid js file for js, because if cache is active it leads to errors
						var parts = req.originalUrl.split('/');
						// if request for web/lib, ignore it, because no redirect information
						if (parts[1] === 'lib') return res.status(200).send('');
						return res.status(200).send('document.location="/login/index.html?href=/' + parts[1] + '/";');
					} else {
						return res.redirect(redirect);
					}
				}
                var remoteIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
                var whiteListIp = server.io.getWhiteListIpForAddress(remoteIp, settings.whiteListSettings);
				adapter.log.info('whiteListIp ' + whiteListIp);
                if (!whiteListIp || settings.whiteListSettings[whiteListIp].user === 'auth') {
					if (/\.js$/.test(req.originalUrl)) {
						// return always valid js file for js, because if cache is active it leads to errors
						var parts = req.originalUrl.split('/');
						if (parts[1] === 'lib') return res.status(200).send('');
						return res.status(200).send('document.location="/login/index.html?href=/' + parts[1] + '/";');
					} else {
						return res.redirect(redirect);
					}
				}
                req.logIn(settings.whiteListSettings[whiteListIp].user, function (err) {
					return next(err);
                });
            };

            server.app.post('/login', function (req, res, next) {
                var redirect = '/';
                var parts;
                if (req.body.origin) {
                    parts = req.body.origin.split('=');
                    if (parts[1]) redirect = decodeURIComponent(parts[1]);
                }
                if (req.body && req.body.username && settings.addUserName && redirect.indexOf('?') === -1) {
                    parts = redirect.split('#');
                    parts[0] += '?' + req.body.username;
                    redirect = parts.join('#');
                }
                var authenticate = passport.authenticate('local', {
                    successRedirect: redirect,
                    failureRedirect: '/login/index.html' + req.body.origin + (req.body.origin ? '&error' : '?error'),
                    failureFlash: 'Invalid username or password.'
                })(req, res, next);
            });

            server.app.get('/logout', function (req, res) {
                req.logout();
                res.redirect('/login/index.html');
            });

            // route middleware to make sure a user is logged in
            server.app.use(function (req, res, next) {
				// if cache.manifes got back not 200 it makes an error
                if (req.isAuthenticated() ||
                    /cache\.manifest$/.test(req.originalUrl) ||
                    /^\/login\//.test(req.originalUrl) ||
                    /\.ico$/.test(req.originalUrl)
                ) return next();
				
				autoLogonOrRedirectToLogin(req, res, next, '/login/index.html?href=' + encodeURIComponent(req.originalUrl));
            });
        } else {
            server.app.get('/login', function (req, res) {
                res.redirect('/');
            });
            server.app.get('/logout', function (req, res) {
                res.redirect('/');
            });
        }

        // Init read from states
        server.app.get('/state/*', function (req, res) {
            try {
                var fileName = req.url.split('/', 3)[2].split('?', 2);
                adapter.getBinaryState(fileName[0], {user: req.user ? 'system.user.' + req.user : settings.defaultUser}, function (err, obj) {
                    if (!err && obj !== null && obj !== undefined) {
                        res.set('Content-Type', 'text/plain');
                        res.status(200).send(obj);
                    } else {
                        res.status(404).send('404 Not found. File ' + fileName[0] + ' not found');
                    }
                });
            } catch (e) {
                res.status(500).send('500. Error' + e);
            }
        });

        server.app.get('*/_socket/info.js', function (req, res) {
            res.set('Content-Type', 'application/javascript');
            res.status(200).send('var socketUrl = "' + socketUrl + '"; var socketSession = "' + '' + '"; sysLang = "' + lang + '"; socketForceWebSockets = ' + (settings.forceWebSockets ? 'true' : 'false') + ';');
        });

        // Enable CORS
        if (settings.socketio) {
            server.app.use(function (req, res, next) {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
                res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, *');

                // intercept OPTIONS method
                if ('OPTIONS' === req.method) {
                    res.status(200).send(200);
                } else {
                    next();
                }
            });
        }

        var appOptions = {};
        if (settings.cache) appOptions.maxAge = 30758400000;

        server.server = LE.createServer(server.app, settings, settings.certificates, settings.leConfig, adapter.log);
        server.server.__server = server;
    } else {
        adapter.log.error('port missing');
        process.exit(1);
    }

    if (server.server) {
        settings.port = parseInt(settings.port, 10);
        adapter.getPort(settings.port, function (port) {
            port = parseInt(port, 10);
            if (port !== settings.port && !settings.findNextPort) {
                adapter.log.error('port ' + settings.port + ' already in use');
                process.exit(1);
            }
            server.server.listen(port, (!settings.bind || settings.bind === '0.0.0.0') ? undefined : settings.bind || undefined);
            adapter.log.info('http' + (settings.secure ? 's' : '') + ' server listening on port ' + port);
        });
    }

    // activate extensions
    for (var e in extensions) {
        if (!extensions.hasOwnProperty(e)) continue;
        try {
            // for debug purposes try to load file in current directory "/lib/file.js" (elsewise node.js cannot debug it)
            var parts = extensions[e].path.split('/');
            parts.shift();
            var extAPI;
            if (fs.existsSync(__dirname + '/' + parts.join('/'))) {
                extAPI = require(__dirname + '/' + parts.join('/'));
            } else {
                extAPI = require(utils.appName + '.' + extensions[e].path);
            }

            extensions[e].obj = new extAPI(server.server, {secure: settings.secure, port: settings.port}, adapter, extensions[e].config, server.app);
            adapter.log.info('Connect extension "' + extensions[e].path + '"');
        } catch (err) {
            adapter.log.error('Cannot start extension "' + e + '": ' + err);
        }
    }

    // Activate integrated simple API
    if (settings.simpleapi) {
        var SimpleAPI = require(utils.appName + '.simple-api/lib/simpleapi.js');

        server.api = new SimpleAPI(server.server, {secure: settings.secure, port: settings.port}, adapter);
    }

    // Activate integrated socket
    if (ownSocket) {
        var IOSocket = require(utils.appName + '.socketio/lib/socket.js');
        var socketSettings = JSON.parse(JSON.stringify(settings));
        // Authentication checked by server itself
        socketSettings.auth             = false;
        socketSettings.secret           = secret;
        socketSettings.store            = store;
        socketSettings.ttl              = settings.ttl || 3600;
        socketSettings.forceWebSockets  = settings.forceWebSockets || false;
        server.io = new IOSocket(server.server, socketSettings, adapter);
    }

    if (server.app) {
        // deliver web files from objectDB
        server.app.use('/', function (req, res) {
            var url = decodeURI(req.url);

            if (server.api && server.api.checkRequest(url)) {
                server.api.restApi(req, res);
                return;
            }

            if (url === '/' || url === '/index.html') {
                getListOfAllAdapters(function (err, data) {
                    if (err) {
                        res.status(500).send('500. Error' + e);
                    } else {
                        res
                            .set('Content-Type', 'text/html')
                            .status(200)
                            .send(data);
                    }
                });
                return;
            }

            // add index.html
            url = url.replace(/\/($|\?|#)/, '/index.html$1');

            if (url.match(/^\/adapter\//)) {
                // add .admin to adapter name
                url = url.replace(/^\/adapter\/([a-zA-Z0-9-_]+)\//, '/$1.admin/');
            }

            if (url.match(/^\/lib\//)) {
                url = '/' + adapter.name + url;
            }
            if (url.match(/^\/admin\//)) {
                url = '/' + adapter.name + url;
            }
            url = url.split('/');
            // Skip first /
            url.shift();
            // Get ID
            var id = url.shift();
            url = url.join('/');
            var pos = url.indexOf('?');
            var noFileCache;
            if (pos !== -1) {
                url = url.substring(0, pos);
                // disable file cache if request like /vis/files/picture.png?noCache
                noFileCache = true;
            }
            if (settings.cache && cache[id + '/' + url] && !noFileCache) {
                res.contentType(cache[id + '/' + url].mimeType);
                res.status(200).send(cache[id + '/' + url].buffer);
            } else {
                if (id === 'login' && url === 'index.html') {
                    var buffer = fs.readFileSync(__dirname + '/www/login/index.html');
                    if (buffer === null || buffer === undefined) {
                        res.contentType('text/html');
                        res.status(200).send('File ' + url + ' not found', 404);
                    } else {
                        // Store file in cache
                        if (settings.cache) {
                            cache[id + '/' + url] = {buffer: buffer.toString(), mimeType: 'text/html'};
                        }
                        res.contentType('text/html');
                        res.status(200).send(buffer.toString());
                    }

                } else {
                    adapter.readFile(id, url, {user: req.user ? 'system.user.' + req.user : settings.defaultUser, noFileCache: noFileCache}, function (err, buffer, mimeType) {
                        if (buffer === null || buffer === undefined || err) {
                            res.contentType('text/html');
                            res.status(404).send('File ' + url + ' not found: ' + err);
                        } else {
                            // Store file in cache
                            if (settings.cache) {
                                cache[id + '/' + url] = {buffer: buffer, mimeType: mimeType || 'text/javascript'};
                            }
                            res.contentType(mimeType || 'text/javascript');
                            res.status(200).send(buffer);
                        }
                    });
                }
            }
        });
    }

    if (server.server) {
        return server;
    } else {
        return null;
    }
}
