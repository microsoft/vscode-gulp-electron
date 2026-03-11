"use strict";

var assert = require("assert");
var path = require("path");
var es = require("event-stream");
var File = require("vinyl");
var darwin = require("../src/darwin");

function runPatch(opts, inputFiles, cb) {
  var files = {};

  es.readArray(inputFiles)
    .pipe(darwin.patch(opts))
    .on("data", function (f) {
      files[f.relative] = f;
    })
    .on("error", cb)
    .on("end", function () {
      cb(null, files);
    });
}

function createFile(relativePath, contents) {
  return new File({
    cwd: process.cwd(),
    base: process.cwd(),
    path: path.join(process.cwd(), relativePath),
    contents: Buffer.from(contents, "utf8"),
  });
}

describe("darwin patch", function () {
  it("should use separate assets options for app and miniapp", function (cb) {
    var mainAssetsPath = path.join(__dirname, "fixtures", "AssetsMain.car");
    var miniAssetsPath = path.join(__dirname, "fixtures", "AssetsMini.car");

    var mainTarget = path.join(
      "Electron.app",
      "Contents",
      "Resources",
      "Assets.car"
    );
    var miniTarget = path.join(
      "Electron.app",
      "Contents",
      "Applications",
      "Electron MiniApp.app",
      "Contents",
      "Resources",
      "Assets.car"
    );

    runPatch(
      {
        version: "35.0.0",
        productName: "Electron",
        productVersion: "1.0.0",
        darwinMiniAppName: "Electron MiniApp",
        darwinAssetsCar: mainAssetsPath,
        darwinMiniAppAssetsCar: miniAssetsPath,
      },
      [
        createFile(mainTarget, "old-main"),
        createFile(miniTarget, "old-mini"),
      ],
      function (err, files) {
        if (err) {
          return cb(err);
        }

        assert(files[mainTarget]);
        assert(files[miniTarget]);
        assert.equal(files[mainTarget].contents.toString("utf8"), "main-assets-car\n");
        assert.equal(files[miniTarget].contents.toString("utf8"), "mini-assets-car\n");
        cb();
      }
    );
  });

  it("should not patch miniapp assets when only darwinAssetsCar is provided", function (cb) {
    var mainAssetsPath = path.join(__dirname, "fixtures", "AssetsMain.car");

    var mainTarget = path.join(
      "Electron.app",
      "Contents",
      "Resources",
      "Assets.car"
    );
    var miniTarget = path.join(
      "Electron.app",
      "Contents",
      "Applications",
      "Electron MiniApp.app",
      "Contents",
      "Resources",
      "Assets.car"
    );

    runPatch(
      {
        version: "35.0.0",
        productName: "Electron",
        productVersion: "1.0.0",
        darwinMiniAppName: "Electron MiniApp",
        darwinAssetsCar: mainAssetsPath,
      },
      [
        createFile(mainTarget, "old-main"),
        createFile(miniTarget, "old-mini"),
      ],
      function (err, files) {
        if (err) {
          return cb(err);
        }

        assert(files[mainTarget]);
        assert(files[miniTarget]);
        assert.equal(files[mainTarget].contents.toString("utf8"), "main-assets-car\n");
        assert.equal(files[miniTarget].contents.toString("utf8"), "old-mini");
        cb();
      }
    );
  });
});
