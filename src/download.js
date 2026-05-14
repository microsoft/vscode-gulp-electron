"use strict";

var path = require("path");
const { downloadArtifact } = require("@electron/get");
const ProgressBar = require("progress");
var rename = require("gulp-rename");
var es = require("event-stream");
var zfs = require("gulp-vinyl-zip");
var filter = require("gulp-filter");
const { Octokit } = require("@octokit/rest");
const got = require("got").default;
const sumchecker = require('sumchecker');

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EHOSTUNREACH",
]);

function isTransientNetworkError(err) {
  if (!err) {
    return false;
  }
  if (err.code && TRANSIENT_NETWORK_ERROR_CODES.has(err.code)) {
    return true;
  }
  // got wraps the underlying cause; check it as well.
  if (err.cause && err.cause.code && TRANSIENT_NETWORK_ERROR_CODES.has(err.cause.code)) {
    return true;
  }
  return false;
}

async function withRetry(name, fn, { retries = 5, baseDelayMs = 2000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !isTransientNetworkError(err)) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 30000);
      const code = (err && err.code) || (err.cause && err.cause.code) || "unknown";
      console.warn(
        `[gulp-electron] ${name} failed with ${code} (attempt ${attempt}/${retries}); retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const GOT_RETRY_OPTIONS = {
  limit: 5,
  methods: ["GET", "HEAD"],
  errorCodes: Array.from(TRANSIENT_NETWORK_ERROR_CODES),
  backoffLimit: 30000,
};

async function getDownloadUrl(
  ownerRepo, customTag,
  { version, platform, arch, token, artifactName, artifactSuffix }
) {
  const [owner, repo] = ownerRepo.split("/");
  const octokit = new Octokit({ auth: token });
  const releaseVersion = version.startsWith("v") ? version : `v${version}`;
  const tag = customTag ?? releaseVersion;

  const { data: release } = await octokit.repos.getReleaseByTag({
    owner,
    repo,
    tag,
  });

  if (!release) {
    throw new Error(`Release for ${releaseVersion} not found`);
  }

  const { data: assets } = await octokit.repos.listReleaseAssets({
    owner,
    repo,
    release_id: release.id,
  });

  artifactName = artifactName || "electron";

  const targetName = artifactSuffix ?
    `${artifactName}-${releaseVersion}-${platform}-${arch}-${artifactSuffix}.zip` :
    `${artifactName}-${releaseVersion}-${platform}-${arch}.zip`;
  const asset = assets.find((asset) => {
    return asset.name === targetName;
  });

  if (!asset) {
    throw new Error(`Release asset for ${releaseVersion} not found`);
  }

  const requestOptions = await octokit.repos.getReleaseAsset.endpoint({
    owner,
    repo,
    asset_id: asset.id,
    headers: {
      Accept: "application/octet-stream",
    },
  });

  const { url, headers } = requestOptions;
  headers.authorization = `token ${token}`;

  const response = await withRetry("HEAD release asset", () =>
    got(url, {
      followRedirect: false,
      method: "HEAD",
      headers,
      retry: GOT_RETRY_OPTIONS,
    })
  );

  return response.headers.location;
}

async function download(opts) {
  let bar;

  if (!opts.version) {
    throw new Error("Missing version");
  }

  if (!opts.platform) {
    throw new Error("Missing platform");
  }

  let arch = opts.arch;
  if (!arch) {
    switch (opts.platform) {
      case "darwin":
        arch = "x64";
        break;
      case "win32":
        arch = "x64";
        break;
      case "linux":
        arch = "x64";
        break;
    }
  }

  let downloadOpts = {
    version: opts.version,
    platform: opts.platform,
    arch,
    artifactName: opts.artifactName,
    artifactSuffix: opts.artifactSuffix,
    token: opts.token,
    downloadOptions: {
      getProgressCallback: (progress) => {
        if (bar) bar.update(progress.percent);
      },
    },
  };

  bar = new ProgressBar(
    `Downloading ${opts.artifactName}: [:bar] :percent ETA: :eta seconds `,
    {
      curr: 0,
      total: 100,
    }
  );

  if (opts.repo) {
    const url = await withRetry("resolve release asset URL", () =>
      getDownloadUrl(opts.repo, opts.tag, downloadOpts)
    );

    downloadOpts = {
      ...downloadOpts,
      mirrorOptions: {
        mirror: `https://github.com/${opts.repo}/releases/download/`,
        resolveAssetURL: () => url,
      },
      unsafelyDisableChecksums: true,
    };
  }

  const start = new Date();
  bar.start = start;

  return await withRetry(`download ${opts.artifactName || "electron"}`, () =>
    downloadArtifact(downloadOpts)
  );
}

function downloadStream(opts) {
  return es.readable(function (_, cb) {
    download(opts).then(
      async (assets) => {
        if (opts.validateChecksum) {
          try {
            await sumchecker('sha256', opts.checksumFile, path.dirname(assets), [
              path.basename(assets),
            ]);
          } catch (err) {
            return cb(err);
          }
        }
        zfs
          .src(assets)
          .on("data", (data) => this.emit("data", data))
          .on("error", (err) => this.emit("error", err))
          .on("end", () => this.emit("end"));
      },
      (err) => cb(err)
    );
  });
}

function getDarwinLibFFMpegPath(opts) {
  return path.join(
    "Electron.app",
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Libraries",
    "libffmpeg.dylib"
  );
}

module.exports = function (opts) {
  const downloadOpts = {
    ...opts,
    arch: opts.arch === "arm" ? "armv7l" : opts.arch,
    artifactName: "electron",
  };

  if (opts.symbols) {
    return downloadStream({ ...downloadOpts, artifactSuffix: "symbols" });
  } else if (opts.pdbs) {
    return downloadStream({ ...downloadOpts, artifactSuffix: "pdb" });
  } else {
    let electron = downloadStream(downloadOpts);

    if (!opts.ffmpegChromium) {
      return electron;
    }

    electron = electron.pipe(filter(["**", "!**/*ffmpeg.*"]));

    let ffmpeg = downloadStream({
      ...downloadOpts,
      artifactName: "ffmpeg",
    }).pipe(filter("**/*ffmpeg.*"));

    if (opts.platform === "darwin") {
      ffmpeg = ffmpeg.pipe(rename(getDarwinLibFFMpegPath(opts)));
    }

    return es.merge(electron, ffmpeg);
  }
};

module.exports.download = download;
