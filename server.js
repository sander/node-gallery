var crypto = require('crypto');
var ejs = require('ejs');
var express = require('express');
var fs = require('fs');
var im = require('imagemagick');

var ALBUM_DIR = process.env.NODE_GALLERY_DIR || '/albums';
var THUMBNAIL_SIZE = 96;
var DISPLAY_SIZE = 640;
var ALBUM_PREVIEW_WIDTH = 288;
var ALBUM_PREVIEW_HEIGHT = 96;
var PORT = process.env.NODE_GALLERY_PORT || 8080;

var SECRET = crypto.randomBytes(48).toString('hex');

var app = express.createServer();
app.use(express.bodyParser());
app.use(express.cookieParser());
app.use(express.session({ secret: SECRET }));

var albums = {};

function respond(request, response, templateName, locals) {
  locals.authenticated = !!request.session.passwords;

  var template = fs.readFileSync(
    __dirname + '/templates/' + templateName + '.html', 'utf8');
  var body = ejs.render(template, { locals: locals });

  response.send(body);
}

function directoryExists(path) {
  try { return fs.statSync(path).isDirectory(); }
  catch (e) { return false; }
}

function exists(path) {
  try { return !!fs.statSync(path); }
  catch (e) { return false; }
}

function ensureDirectory(path) {
  if (!directoryExists(path)) fs.mkdir(path, 0755);
}

function formatDate(date) {
  var s = '';
  if (date.getMonth() + 1 < 10) s += '0';
  s += date.getMonth() + '/';
  if (date.getDate() < 10) s += '0';
  s += date.getDate() + '/' + date.getFullYear();
  return s;
}

function getAlbumInfo(name, type) {
  if (albums[name]) return albums[name];

  var info = {
    title: name,
    photos: [],
    url: 'album/' + name + '/',
    preview: 'preview/' + name 
  };

  if (type) {
    info.directory = ALBUM_DIR + '/' + type + '/' + name;
    info.type = type;
  } else {
    ['public', 'protected', 'private', 'hidden'].forEach(function(type) {
      var candidate = ALBUM_DIR + '/' + type + '/' + name;
      if (directoryExists(candidate)) {
        info.directory = candidate;
        info.type = type;
      }
    });
  }

  if (!info.directory) return null;

  info.created = formatDate(fs.statSync(info.directory).ctime);
  info.createdRaw = fs.statSync(info.directory).ctime.valueOf();

  ensureDirectory(info.directory + '/thumbnails');
  ensureDirectory(info.directory + '/display');
  ensureDirectory(info.directory + '/meta');

  if (info.type == 'protected' || info.type == 'private') {
    var passwordPath = info.directory + '/meta/password';
    if (exists(passwordPath))
      info.password = fs.readFileSync(passwordPath, 'utf8').trim();
  }

  fs.readdirSync(info.directory).forEach(function(file) {
    if (file == 'meta') {
    } else if (file == 'display') {
    } else if (file == 'thumbnails') {
    } else info.photos.push(file);
  });

  info.photos.sort(function(a, b) {
    if (a > b) return 1;
    else return -1;
  });

  albums[name] = info;

  return info;
}

app.get('/', function(request, response) {
  var locals = {
    albums: []
  };

  ['public', 'protected'].forEach(function(type) {
    fs.readdirSync(ALBUM_DIR + '/' + type).forEach(function(file) {
      locals.albums.push(getAlbumInfo(file, type));
    });
  });

  locals.albums.sort(function(a, b) {
    if (a.createdRaw < b.createdRaw) return 1;
    else return -1;
  });

  respond(request, response, 'index', locals);
});

function checkAuthentication(request, response, album) {
  if (album.type != 'protected' && album.type != 'private') return true;

  if (request.session.passwords && request.session.passwords[album.title])
    return true;

  response.redirect(
    '/authenticate?album=' + album.title + '&redirect=' + request.url);

  return false;
}

app.get('/forget-passwords', function(request, response) {
  delete request.session.passwords;
  response.redirect('/');
});

app.get('/authenticate', function(request, response) {
  var album = getAlbumInfo(request.query.album);

  var locals = {
    album: album,
    redirect: request.query.redirect,
    wrong: !!request.query.wrong
  };

  respond(request, response, 'authenticate', locals);
});

app.post('/authenticate', function(request, response) {
  var password = request.body.password;
  var album = getAlbumInfo(request.query.album);

  if (album.password == password) {
    if (!request.session.passwords) request.session.passwords = {};
    request.session.passwords[album.title] = password;
    response.redirect(request.query.redirect);
  } else {
    response.redirect(request.url + '&wrong=1');
  }
});

app.get('/album/:album/', function(request, response) {
  var album = getAlbumInfo(request.params.album);

  if (!checkAuthentication(request, response, album)) return;

  var locals = {
    album: album,
  };

  respond(request, response, 'album', locals);
});

app.get('/album/:album/:photo/', function(request, response) {
  var album = getAlbumInfo(request.params.album);

  if (!checkAuthentication(request, response, album)) return;

  var locals = {
    album: album,
    photo: request.params.photo,
    title: request.params.photo.replace(/\.(JPG|jpg|jpeg)/, ''),
    previous: null,
    next: null
  };

  var index = locals.album.photos.indexOf(locals.photo);
  if (index != 0)
    locals.previous = locals.album.photos[index - 1];
  if (index != locals.album.photos.length - 1)
    locals.next = locals.album.photos[index + 1];

  respond(request, response, 'photo', locals);
});

function sendFile(request, response, path) {
  fs.stat(path, function(error, stat) {
    response.setHeader('Content-Length', stat.size);
    response.setHeader('Content-Type', 'image/jpeg');
    response.setHeader(
      'Cache-Control', 'public, max-age=' + (60 * 60 * 24 * 7));
    response.setHeader('Last-Modified', stat.mtime.toUTCString());
    response.setHeader(
      'ETag', '"' + stat.size + '-' + Number(stat.mtime) + '"');

    if (request.method == 'HEAD') return response.end();

    fs.createReadStream(path).pipe(response);
  });
}

var resizes = [];
var resizing = false;
function queueResize(options, callback) {
  console.log('queueing resize: ' + options.dstPath);
  resizes.push({
    options: options,
    callback: callback
  });
  if (!resizing) resize();
}
function resize() {
  resizing = true;
  var entry = resizes.pop();
  console.log('starting resize: ' + entry.options.dstPath);
  im.resize(entry.options, function(error, stdout, stderr) {
    entry.callback(error, stdout, stderr);

    console.log('resized: ' + entry.options.dstPath);
    if (resizes.length) resize();
    else resizing = false;
  });
}

function sendResizedPhoto(request, response, type) {
  var album = getAlbumInfo(request.params.album);

  if (!checkAuthentication(request, response, album)) return;

  if (type == 'thumbnail') {
    var subdir = 'thumbnails';
    var size = THUMBNAIL_SIZE;
    var strip = true;
  } else if (type == 'display') {
    var subdir = 'display';
    var size = DISPLAY_SIZE;
    var strip = false;
  }
  var path = album.directory + '/' + subdir + '/' + request.params.photo;

  if (!exists(path)) {
    queueResize({
      srcPath: album.directory + '/' + request.params.photo,
      dstPath: path,
      width: size,
      height: size,
      strip: strip
    }, function(error, stdout, stderr) {
      if (!error) {
        sendFile(request, response, path);
      }
    });
  } else {
    sendFile(request, response, path);
  }
}

app.get('/album/:album/:photo/original', function(request, response) {
  var album = getAlbumInfo(request.params.album);

  if (!checkAuthentication(request, response, album)) return;

  var path = album.directory + '/' + request.params.photo;
  sendFile(request, response, path);
});

app.get('/album/:album/:photo/display', function(request, response) {
  sendResizedPhoto(request, response, 'display');
});

app.get('/album/:album/:photo/thumbnail', function(request, response) {
  sendResizedPhoto(request, response, 'thumbnail');
});

app.get('/preview/:album', function(request, response) {
  var album = getAlbumInfo(request.params.album);

  // No authentication check here, because we want to show these previews.

  var path = album.directory + '/meta/preview.jpg';

  if (album.photos.length == 0)
    return response.end()

  if (!exists(path)) {
    var imagePath = album.directory + '/' +
      album.photos[Math.floor(Math.random() * album.photos.length)];
    im.resize({
      srcPath: imagePath,
      dstPath: path,
      width: ALBUM_PREVIEW_WIDTH,
      strip: true
    }, function(error, stdout, stderr) {
      im.convert([
        path,
        '-crop',
        ALBUM_PREVIEW_WIDTH + 'x' + ALBUM_PREVIEW_HEIGHT + '+0+0',
        '-gravity',
        'center',
        '+repage',
        path
      ], function(error, metadata) {
        if (!error) sendFile(request, response, path);
        else console.log(error);
      });
      /*
      // Doesn't do its job?
      im.crop({
        srcPath: path,
        dstPath: path,
        width: ALBUM_PREVIEW_WIDTH,
        height: ALBUM_PREVIEW_HEIGHT,
        strip: true
      }, function(error, stdout, stderr) {
        if (!error) sendFile(request, response, path);
      });
      */
    });
  } else {
    sendFile(request, response, path);
  }
});

app.use('/static', express.static(__dirname + '/static'));

app.listen(PORT);
