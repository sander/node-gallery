node-gallery
============

node-gallery is a photo gallery created in Node that uses the file system
instead of an additional database.


Getting started
---------------

1. Install [Node](http://nodejs.org/) and [npm](http://npmjs.org/).
2. Install ImageMagick (Ubuntu: `sudo apt-get install imagemagick`).
3. Run `npm install ejs express imagemagick` within the node-gallery dir.
4. In the node-gallery dir, create a subdirectory called *albums* containing
   the directories *public*, *private*, *hidden* and *protected*.
5. Run `node server.js` (and restart each time an album has changed).


Creating albums
---------------

A photo album is a directory within a subdirectory of *albums*. Its name is
displayed as the album title.

Public and protected albums are visible on the homepage.

Private and protected albums require a password. Put the password in the
*meta/password* file the album directory.
