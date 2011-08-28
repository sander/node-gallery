var ejs = require('ejs');
var express = require('express');
var fs = require('fs');
var im = require('imagemagick');

var ALBUM_DIR = __dirname + '/albums';
var THUMBNAIL_SIZE = 96;
var DISPLAY_SIZE = 640;
var ALBUM_PREVIEW_WIDTH = 288;
var ALBUM_PREVIEW_HEIGHT = 96;

var app = express.createServer();

function respond(response, templateName, locals) {
  var template = fs.readFileSync(__dirname + '/templates/' + templateName + '.html', 'utf8');
  var body = ejs.render(template, { locals: locals });

  response.send(body);
}

function directoryExists(path) {
  try {
    return fs.statSync(path).isDirectory();
  } catch (e) {
    return false;
  }
}

function exists(path) {
  try {
    return !!fs.statSync(path);
  } catch (e) {
    return false;
  }
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

  if (!info.directory)
    return null;

  info.created = formatDate(fs.statSync(info.directory).ctime);

  ensureDirectory(info.directory + '/thumbnails');
  ensureDirectory(info.directory + '/display');
  ensureDirectory(info.directory + '/meta');

  fs.readdirSync(info.directory).forEach(function(file) {
    if (file == 'meta') {
    } else if (file == 'display') {
    } else if (file == 'thumbnails') {
    } else info.photos.push(file);
  });

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

  respond(response, 'index', locals);
});

app.get('/album/:album/', function(request, response) {
  var album = getAlbumInfo(request.params.album);
  var locals = {
    album: album,
  };

  respond(response, 'album', locals);
});

app.get('/album/:album/:photo/', function(request, response) {
  var locals = {
    album: getAlbumInfo(request.params.album),
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

  respond(response, 'photo', locals);
});

function sendFile(request, response, path) {
  fs.stat(path, function(error, stat) {
    response.setHeader('Content-Length', stat.size);
    response.setHeader('Content-Type', 'image/jpeg');
    response.setHeader('Cache-Control', 'public, max-age=' + (60 * 60 * 24 * 7));
    response.setHeader('Last-Modified', stat.mtime.toUTCString());
    response.setHeader('ETag', '"' + stat.size + '-' + Number(stat.mtime) + '"');

    if (request.method == 'HEAD') return response.end();

    fs.createReadStream(path).pipe(response);
  });
}

function sendResizedPhoto(request, response, type) {
  if (type == 'thumbnail') {
    var subdir = 'thumbnails';
    var size = THUMBNAIL_SIZE;
    var strip = true;
  } else if (type == 'display') {
    var subdir = 'display';
    var size = DISPLAY_SIZE;
    var strip = false;
  }
  var album = getAlbumInfo(request.params.album);
  var path = album.directory + '/' + subdir + '/' + request.params.photo;

  if (!exists(path)) {
    im.resize({
      srcPath: album.directory + '/' + request.params.photo,
      dstPath: path,
      width: size,
      height: size,
      strip: strip
    }, function(error, stdout, stderr) {
      if (!error) sendFile(request, response, path);
    });
  } else {
    sendFile(request, response, path);
  }
}

app.get('/album/:album/:photo/original', function(request, response) {
  var album = getAlbumInfo(request.params.album);
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
  var path = album.directory + '/meta/preview.jpg';

  if (album.photos.length == 0)
    return response.end()

  if (!exists(path)) {
    im.crop({
      srcPath: album.directory + '/' + album.photos[0],
      dstPath: path,
      width: ALBUM_PREVIEW_WIDTH,
      height: ALBUM_PREVIEW_HEIGHT,
      strip: true
    }, function(error, stdout, stderr) {
      if (!error) sendFile(request, response, path);
    });
  } else {
    sendFile(request, response, path);
  }
});

app.use('/static', express.static(__dirname + '/static'));

app.listen(3000);
