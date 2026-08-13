"use strict";

var fs = require("fs");
var path = require("path");
var es = require("event-stream");
var rename = require("gulp-rename");
var temp = require("temp").track();
var rcedit = require("rcedit");
var semver = require("semver");
var { spawnSync } = require("child_process");
var { pipeline } = require("stream");

var cachedSignToolPath;

function getOriginalAppName(opts) {
  return semver.gte(opts.version, "0.24.0") ? "electron" : "atom";
}

function getOriginalAppFullName(opts) {
  return getOriginalAppName(opts) + ".exe";
}

function getSignTool() {
  if (cachedSignToolPath) {
    return cachedSignToolPath;
  }

  let windowsSDKDir = "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\";
  if (!fs.existsSync(windowsSDKDir)) {
    throw new Error(`There is no Windows 10 SDK installed at ${windowsSDKDir}.`);
  }

  let findSignTool = (start) => {
    let signToolPaths = [];
    fs.readdirSync(start).forEach(file => {
      const filename = path.join(start, file);
      const stat = fs.lstatSync(filename);
      if (stat.isDirectory()) {
        signToolPaths = signToolPaths.concat(findSignTool(filename));
      } else if (filename.endsWith("signtool.exe")) {
        signToolPaths.push(filename);
      }
    });
    return signToolPaths;
  }
  let signToolPaths = findSignTool(windowsSDKDir);
  let latestWindowsSDKVersion = signToolPaths.map(x => x.replace(windowsSDKDir, "").split("\\")[0]).pop();
  let latestWindowsSDKSignTools = signToolPaths.filter(x => x.startsWith(`${windowsSDKDir}${latestWindowsSDKVersion}`));
  let x64SignTool = latestWindowsSDKSignTools.find(x => x.includes("x64"));
  if (x64SignTool) {
    cachedSignToolPath = x64SignTool;
    return cachedSignToolPath;
  }
  let x86SignTool = latestWindowsSDKSignTools.find(x => x.includes("x86"));
  if (x86SignTool) {
    cachedSignToolPath = x86SignTool;
    return cachedSignToolPath;
  }
  throw new Error(`No supported version for signtool installed in ${windowsSDKDir}${latestWindowsSDKVersion}`);
}

function writeContentsToFile(f, targetPath, cb) {
  if (Buffer.isBuffer(f.contents)) {
    return fs.writeFile(targetPath, f.contents, cb);
  }

  pipeline(f.contents, fs.createWriteStream(targetPath), cb);
}

exports.getAppPath = function (opts) {
  if (opts.createVersionedResources) {
    if (!opts.productVersionString) {
      throw new Error("productVersionString must be defined.");
    }
    return path.join(opts.productVersionString, "resources", "app");
  }
  return path.join("resources", "app");
};

function applyRcedit(f, patch, cb) {
  var tempPath = temp.path();

  writeContentsToFile(f, tempPath, function (err) {
    if (err) {
      return cb(err);
    }

    rcedit(tempPath, patch).then(() => {
      fs.readFile(tempPath, function (err, data) {
        if (err) {
          return cb(err);
        }

        f.contents = data;

        fs.unlink(tempPath, function (err) {
          if (err) {
            return cb(err);
          }

          cb(null, f);
        });
      });
    }).catch(err => {
      if (err) {
        return cb(err);
      }
    });
  });
}

function removeSignature(f, cb, dependencies) {
  if (!/\.(?:dll|exe)$/i.test(f.relative)) {
    return cb(null, f);
  }

  dependencies = dependencies || { getSignTool, spawnSync };
  var tempPath = temp.path({ suffix: path.extname(f.relative) });

  writeContentsToFile(f, tempPath, function (err) {
    if (err) {
      return cb(err);
    }

    let signToolPath;
    try {
      signToolPath = dependencies.getSignTool();
    } catch (err) {
      return fs.unlink(tempPath, function () {
        cb(err);
      });
    }

    const verification = dependencies.spawnSync(
      signToolPath,
      ["verify", "/pa", "/all", "/v", tempPath],
      { encoding: "utf8" }
    );
    if (verification.error) {
      return fs.unlink(tempPath, function () {
        cb(verification.error);
      });
    }
    const verificationOutput = [verification.stdout, verification.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const hasSignature = verification.status === 0 || /Signature Index:\s*\d+/i.test(verificationOutput);
    if (!hasSignature) {
      if (/no signature found/i.test(verificationOutput)) {
        return fs.readFile(tempPath, function (err, data) {
          if (err) {
            return cb(err);
          }

          f.contents = data;
          fs.unlink(tempPath, function (err) {
            cb(err || null, f);
          });
        });
      }

      const err = new Error(
        `Failed to inspect code signature for ${f.relative}${verificationOutput ? `: ${verificationOutput}` : ""}`
      );
      return fs.unlink(tempPath, function () {
        cb(err);
      });
    }

    const result = dependencies.spawnSync(signToolPath, ["remove", "/s", tempPath], {
      encoding: "utf8",
    });
    if (result.error) {
      return fs.unlink(tempPath, function () {
        cb(result.error);
      });
    }
    const output = (result.stderr || result.stdout || "").trim();
    const hasNoSignature = /no signatures? found/i.test(output);
    if (result.status !== 0 && !hasNoSignature) {
      const err = new Error(
        `Failed to remove code signature from ${f.relative}${output ? `: ${output}` : ""}`
      );
      return fs.unlink(tempPath, function () {
        cb(err);
      });
    }

    fs.readFile(tempPath, function (err, data) {
      if (err) {
        return cb(err);
      }

      f.contents = data;

      fs.unlink(tempPath, function (err) {
        if (err) {
          return cb(err);
        }

        cb(null, f);
      });
    });
  });
}

function removeSignatures() {
  if (process.platform !== "win32") {
    return es.through();
  }

  return es.map(removeSignature);
}

exports._removeSignature = removeSignature;

function patchExecutable(opts) {
  return es.map(function (f, cb) {
    if (process.platform !== "win32") {
      return cb(null, f);
    }

    if (f.relative === getOriginalAppFullName(opts)) {
      var patch = {
        "version-string": {
          CompanyName: opts.companyName || "GitHub, Inc.",
          FileDescription: opts.productAppName || opts.productName,
          LegalCopyright:
            opts.copyright ||
            "Copyright (C) 2014 GitHub, Inc. All rights reserved",
          ProductName: opts.productAppName || opts.productName,
          ProductVersion: opts.productVersion,
        },
        "file-version": opts.productVersion,
        "product-version": opts.productVersion,
      };

      if (opts.createVersionedResources) {
        if (!opts.productVersionString) {
          throw new Error("productVersionString must be defined.");
        }
        patch["resource-string"] = {
          2: opts.productVersionString
        };
      }

      if (opts.winIcon) {
        patch.icon = opts.winIcon;
      }

      return applyRcedit(f, patch, cb);
    }

    if (opts.win32ProxyAppName && f.relative === "electron_proxy.exe") {
      var patch = {
        "version-string": {
          CompanyName: opts.companyName || "GitHub, Inc.",
          FileDescription: opts.win32ProxyAppName,
          LegalCopyright:
            opts.copyright ||
            "Copyright (C) 2014 GitHub, Inc. All rights reserved",
          ProductName: opts.win32ProxyAppName,
          ProductVersion: opts.productVersion,
        },
        "file-version": opts.productVersion,
        "product-version": opts.productVersion,
        "resource-string": {
          3: `${opts.productName}.exe`
        },
      };

      if (opts.createVersionedResources) {
        if (!opts.productVersionString) {
          throw new Error("productVersionString must be defined.");
        }
        patch["resource-string"][2] = opts.productVersionString;
      }

      if (opts.win32ProxyIcon) {
        patch.icon = opts.win32ProxyIcon;
      }

      return applyRcedit(f, patch, cb);
    }

    return cb(null, f);
  });
}

function removeDefaultApp() {
  var defaultAppPath = path.join("resources", "default_app");

  return es.mapSync(function (f) {
    if (!f.relative.startsWith(defaultAppPath)) {
      return f;
    }
  });
}

function renameApp(opts) {
  return rename(function (path) {
    if (path.dirname === "." && path.extname === ".exe") {
      if (path.basename === getOriginalAppName(opts)) {
        path.basename = opts.productName;
      } else if (opts.win32ProxyAppName && path.basename === "electron_proxy") {
        path.basename = opts.win32ProxyAppName;
      }
    }
  });
}

function moveFilesExceptExecutable(opts) {
  const versionFolder = opts.productVersionString;
  if (!versionFolder) {
    throw new Error("productVersionString must be defined.");
  }
  return es.mapSync(function (f) {
    // Skip if the file is the renamed executable
    if (
      f.relative === `${opts.productName}.exe`
    ) {
      return f;
    }

    // Skip if the file is the renamed proxy executable
    if (
      opts.win32ProxyAppName &&
      f.relative === `${opts.win32ProxyAppName}.exe`
    ) {
      return f;
    }

    // Move other files to version subfolder
    if (f.path && f.base) {
      const relativePath = path.relative(f.base, f.path);
      f.path = path.join(f.base, versionFolder, relativePath);
    }

    return f;
  });
}

exports.patch = function (opts) {
  var pass = es.through();

  var src = pass
    .pipe(opts.keepDefaultApp ? es.through() : removeDefaultApp())
    .pipe(removeSignatures())
    .pipe(patchExecutable(opts))
    .pipe(renameApp(opts))
    .pipe(opts.createVersionedResources ? moveFilesExceptExecutable(opts) : es.through());

  return es.duplex(pass, src);
};
