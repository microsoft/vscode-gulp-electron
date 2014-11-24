'use strict';

var es = require('event-stream');
var fs = require('vinyl-fs');
var rename = require('gulp-rename');
var downloadAtomShell = require('gulp-download-atom-shell');
var json = require('gulp-json-editor');
var gulpif = require('gulp-if');
var rimraf = require('rimraf');

var platform = require('./' + (function (platform) {
	switch (platform) {
		case 'win32': return 'win';
		default: return platform;
	}
})(process.platform));

module.exports = function(opts) {
	if (!opts.version) {
		throw new Error('Missing atom-shell option: version.');
	}
	
	if (!opts.outputPath) {
		throw new Error('Missing atom-shell option: outputPath.');
	}
	
	if (!opts.productName) {
		throw new Error('Missing atom-shell option: productName.');
	}
	
	if (!opts.productVersion) {
		throw new Error('Missing atom-shell option: productVersion.');
	}

	var pass = es.through();
	var src = pass.pipe(gulpif(function(f) { return f.relative === 'package.json'; }, json(function (json) {
		json.name = opts.productName;
		return json;
	})));

	var atomshell = es.readable(function (_, cb) {
		var that = this;

		rimraf(opts.outputPath, function (err) {
			if (err) { return cb(err); }

			downloadAtomShell({
				version: opts.version,
				outputDir: opts.outputPath
			}, function() {
				platform.patchAtom(opts, function (err) {
					if (err) { return cb(err); }

					src.pipe(fs.dest(opts.outputPath + '/' + platform.getAppPath(opts.productName)))
						.on('end', that.emit.bind(that, 'end'));
				});
			});
		});
	});

	return es.duplex(pass, atomshell);
};
