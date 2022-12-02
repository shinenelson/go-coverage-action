const core = require('@actions/core');
const github = require('@actions/github');

const events = require('events');
const {execa} = require('execa');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const {version} = require('./package.json');



const tmpdir = process.env['RUNNER_TEMP'];
const ctx = github.context;


const DATA_FMT_VERSION = 1;


async function exec(cmd, args, stdin) {
  try {
    const wd = core.getInput('working-directory');
    core.startGroup(`$ ${cmd} ${args.join(' ')}`);
    const subprocess = execa(cmd, args,
      {
        cwd: wd,
        env: {
          ...process.env,
          'GIT_AUTHOR_NAME': 'Go Coverage Action',
          'GIT_AUTHOR_EMAIL': '<>',
          'GIT_COMMITTER_NAME': 'Go Coverage Action',
          'GIT_COMMITTER_EMAIL': '<>',
        },
        all: true,
        input: stdin,
      });
    subprocess.all.pipe(process.stdout);
    const {all} = await subprocess;
    return {output: all};
  } catch (e) {
    core.warning(`Failed to run ${cmd} ${args.join(' ')}`);
    throw (e);
  } finally {
    core.endGroup();
  }
}


async function setup() {
  await exec('go', ['version']);
  await fetchCoverage();
}


async function fetchCoverage() {
  try {
    await exec('git', ['fetch', 'origin',
      '+refs/notes/gocoverage:refs/notes/gocoverage']);
  } catch (e) {
    // expected to fail if the ref hasn't been created yet
    core.info('no existing gocoverage ref');
  }
}


async function setCoverageNote(data) {
  const jsdata = JSON.stringify(data);
  core.startGroup('new coverage raw data');
  core.info(`new coverage data:  ${jsdata}`);
  core.endGroup();
  await fetchCoverage();
  await exec('git', ['notes',
    '--ref=gocoverage',
    'add',
    '-f', '--file=-', ctx.sha], jsdata);
  await exec('git', ['push', 'origin', 'refs/notes/gocoverage']);
}


async function getPriorCoverage() {
  const stats = {'coverage_pct': null, 'pkg_stats': {}};
  const pl = ctx.payload;
  const ref = pl.pull_request ? pl.pull_request.base.sha : pl.before;
  if (!ref) {
    return stats;
  }
  try {
    const {output} = await exec('git',
      ['log',
        '--notes=gocoverage',
        '--pretty=format:%H%n%N',
        '--grep=coverage_pct', '-n', '1', ref]);

    try {
      core.startGroup('prior coverage raw data');
      core.info(`prior coverage data:  ${output}`);
      core.endGroup();
      const lines = output.split('\n');
      const sha = lines[0];
      const data = JSON.parse(lines[1]);
      data['sha'] = sha;
      return data;
    } catch (e) {
      core.info(`failed to decode prior coverage: ${e}`);
      return stats;
    }
  } catch (e) {
    // git log may fail if an invalid ref is given; that's ok.
  }
  core.info(`no prior coverage found`);
  return stats;
}

function packageDelta(prior, now) {
  const priorPkgNames = Object.keys(prior);
  const nowPkgNames = Object.keys(now);
  const allNames = new Set(priorPkgNames.concat(nowPkgNames));
  const pkgs = [];
  for (const pkgName of [...allNames].sort()) {
    const priorPct = prior[pkgName]?.[0] || 0;
    const nowPct = now[pkgName]?.[0] || 0;
    // only count as changed if delta is >0.1%
    if (Math.abs(priorPct - nowPct) >= 0.1) {
      pkgs.push([pkgName, priorPct, nowPct]);
    }
  }
  return pkgs;
}

async function generateCoverage() {
  const report = {
    'pkg_count': 0,
    'with_tests': 0,
    'no_tests': 0,
    'skipped_count': 0,
    'coverage_pct': 0,
    'reportPathname': '',
    'gocovPathname': '',
    'gocovFilteredPathname': '',
  };

  report.gocovPathname = path.join(tmpdir, 'go.cov');
  report.gocovFilteredPathname = path.join(tmpdir, 'go-filtered.cov');

  const filename = core.getInput('report-filename');
  report.reportPathname = filename.startsWith('/') ? filename : path.join(tmpdir, filename);


  const coverMode = core.getInput('cover-mode');
  const coverPkg = core.getInput('cover-pkg');

  let testArgs;
  try {
    testArgs = JSON.parse(core.getInput('test-args'));
    if (!Array.isArray(testArgs)) {
      throw ('not an array');
    }
  } catch (e) {
    throw (`invalid value for test-args; must be a JSON array of strings, got ${testArgs} (${e})`);
  }

  const args = ['test'].concat(testArgs).concat([
    '-covermode', coverMode,
    '-coverprofile', report.gocovPathname,
    ...(coverPkg ? ['-coverpkg', coverPkg] : []),
    './...'
  ]);
  //const {output: testOutput} = await exec('go', args);
  await exec('go', args);

  const pkgStats = {};
  const [globalPct, skippedFileCount, pkgStmts] = await calcCoverage(report.gocovPathname, report.gocovFilteredPathname);
  for (const [pkgPath, [stmtCount, matchCount]] of Object.entries(pkgStmts)) {
    report.pkg_count++;
    pkgStats[pkgPath] = [matchCount / stmtCount * 100];
    if (matchCount > 0) {
      report.with_tests++;
    } else {
      report.no_tests++;
    }
  }
  report.coverage_pct = globalPct;
  report.pkg_stats = pkgStats;
  report.skipped_count = skippedFileCount;

  await exec('go', ['tool', 'cover', '-html', report.gocovPathname, '-o', report.reportPathname]);
  core.info(`Generated ${report.reportPathname}`);

  return report;
}

// parse the go.cov file to calculate "true" coverage figures per package
// regardless of whether coverpkg is used.
async function calcCoverage(goCovFilename, filteredFilename) {
  const pkgStats = {};
  const seenIds = {};
  let globalStmts = 0;
  let globalCount = 0;
  let skippedFiles = new Set();

  const ignorePatterns = core.getMultilineInput('ignore-pattern').map(pat => new RegExp(pat.trim()));
  core.info(`Ignoring ${ignorePatterns.length} filename patterns`);

  const wl = fs.createWriteStream(filteredFilename);
  wl.write('mode: set\n');

  const rl = readline.createInterface({
    input: fs.createReadStream(goCovFilename),
    crlfDelay: Infinity
  });

  // TODO: write an entry to wl for each id; write if set, write zeroes if not set at end

  const re = /^(.+) (\d+) (\d+)$/;
  rl.on('line', (line) => {
    const m = line.match(re);
    if (!m) return;
    const id = m[1]; // statement identifier; pkgpath + stmt offset
    const pkgPath = path.dirname(id);
    const fn = id.split(':')[0];
    for (const re of ignorePatterns) {
      if (fn.match(re)) {
        if (!skippedFiles.has(fn)) {
          core.info('Skipping ' + fn);
        }
        skippedFiles.add(fn);
        return;
      }
    }
    const stmtCount = Number(m[2]);
    const matchCount = Number(m[3]);
    if (!pkgStats[pkgPath]) {
      pkgStats[pkgPath] = [0, 0]; // stmts, covered
    }
    if (!seenIds[id]) {
      globalStmts += stmtCount;
      seenIds[id] = [stmtCount, false];
      pkgStats[pkgPath][0] += stmtCount;
    }
    if (matchCount > 0 && !seenIds[id][1]) {
      globalCount += stmtCount;
      seenIds[id][1] = true;
      pkgStats[pkgPath][1] += stmtCount;
    }
  });

  for (const id of Object.keys(seenIds).sort()) {
    const [stmtCount, isCovered] = seenIds[id];
    wl.write(`{$id} ${stmtCount} ${isCovered ? 1 : 0}\n`);
  }
  wl.end()

  await events.once(rl, 'close');
  const globalPct = globalCount / globalStmts * 100;
  core.info(`Totals stmts=${globalStmts} covered=${globalCount}, pct=${globalPct}`);
  return [globalPct, skippedFiles.size, pkgStats];
}


const commentMarker = '<!-- gocovaction -->';

async function generatePRComment(stats) {
  let commitComment = `${commentMarker}Go test coverage: ${stats.current.coverage_pct.toFixed(1)}% for commit ${ctx.sha}`;

  if (stats.prior.coverage_pct != null) {
    core.info(`Previous coverage: ${stats.prior.coverage_pct}% as of ${stats.prior.sha}`);

    commitComment = `${commentMarker}:arrow_right: Go test coverage stayed the same at ${stats.current.coverage_pct.toFixed(1)}% compared to ${stats.prior.sha}`;
    if (stats.deltaPct > 0) {
      commitComment = `${commentMarker}:arrow_up: Go test coverage increased from ${stats.prior.coverage_pct.toFixed(1)}% to ${stats.current.coverage_pct.toFixed(1)}% compared to ${stats.prior.sha}`;
    } else if (stats.deltaPct < 0) {
      commitComment = `${commentMarker}:arrow_down: Go test coverage decreased from ${stats.prior.coverage_pct.toFixed(1)}% to ${stats.current.coverage_pct.toFixed(1)}% compared to ${stats.prior.sha}`;
    }
    if (stats.current.skipped_count > 0) {
      commitComment += ` <i>(${stats.current.skipped_count} ignored files)</i>`;
    }
  } else {
    core.info('No prior coverage information found in log');
  }
  if (stats.current.no_tests > 0) {
    commitComment += `\n<details><summary>:warning: ${stats.current.no_tests} of ${stats.current.pkg_count} packages have zero coverage.</summary>\n`;
    for (const pkgName of Object.keys(stats.current.pkg_stats).sort()) {
      if (stats.current.pkg_stats[pkgName] == 0) {
        commitComment += `* ${pkgName}\n`;
      }
    }
    commitComment += `</details>\n`;
  }

  if (!stats.meetsThreshold) {
    commitComment += `\n:no_entry: Coverage does not meet minimum requirement of ${stats.minPct}%.\n`;
  }

  const reportUrl = core.getInput('report-url');
  if (reportUrl) {
    commitComment += `\n\n[View full coverage report](${reportUrl})\n`;
  }


  if (stats.prior.coverage_pct !== null) {
    const delta = packageDelta(stats.prior.pkg_stats, stats.current.pkg_stats);
    if (delta.length) {
      const maxPkgLen = Math.max.apply(null, delta.map(pkg => pkg[0].length));
      commitComment += '\nUpdated Package Coverages:\n\n```diff\n';
      commitComment += `# ${'Package Name'.padEnd(maxPkgLen, ' ')} |  Prior |    New\n`;
      for (const pkg of delta) {
        const [pkgName, priorPct, newPct] = pkg;
        const priorPctFmt = priorPct.toFixed(1).padStart(5, ' ') + '%';
        const newPctFmt = newPct.toFixed(1).padStart(5, ' ') + '%';
        commitComment += `${newPct >= priorPct ? '+' : '-'} ${pkgName.padEnd(maxPkgLen, ' ')} | ${priorPctFmt} | ${newPctFmt}\n`;
      }
      commitComment += '```\n\n';
    } else {
      commitComment += `\nNo change in coverage for any package.\n\n`;
    }
  }

  const allMaxPkgLen = Math.max.apply(null, Object.keys(stats.current.pkg_stats).map(pkgName => pkgName.length));
  commitComment += '<details><summary>View coverage for all packages</summary>\n';
  commitComment += '\n```diff\n'
  commitComment += `# ${'Package Name'.padEnd(allMaxPkgLen, ' ')} | Coverage\n`;
  for (const pkgName of Object.keys(stats.current.pkg_stats).sort()) {
    const pct = stats.current.pkg_stats[pkgName][0];
    commitComment += `${pct > 0 ? '+' : '-'} ${pkgName.padEnd(allMaxPkgLen, ' ')} |   ${pct.toFixed(1).padStart(5, ' ')}%\n`;
  }
  commitComment += '```\n</details>\n\n';

  return commitComment;

}


async function findPreviousComment(octokit, issue_number) {
  const it = octokit.paginate.iterator(octokit.rest.issues.listComments, {
    owner: ctx.payload.repository.owner.login,
    repo: ctx.payload.repository.name,
    issue_number: issue_number,
    per_page: 100
  });

  for await (const {data: comments} of it) {
    for (const comment of comments) {
      if (comment.body.startsWith(commentMarker)) {
        return comment.id;
      }
    }
  }
  return null;
}

async function generateReport() {
  await setup();

  const current = await generateCoverage();
  const prior = await getPriorCoverage();
  const minPct = Number(core.getInput('coverage-threshold'));
  const deltaPct = current.coverage_pct - prior.coverage_pct;

  const stats = {
    current,
    prior,
    deltaPct,
    minPct,
    meetsThreshold: current.coverage_pct > minPct,
    deltaPctFmt: Intl.NumberFormat('en-US', {signDisplay: 'exceptZero'}).format(deltaPct)
  };


  core.info(`Found ${stats.current.pkg_count} packages`);
  core.info(`Packages with tests: ${stats.current.with_tests}`);
  core.info(`Packages with zero tests: ${stats.current.no_tests}`);
  core.info(`Total coverage: ${stats.current.coverage_pct}%`);
  core.info(`Minimum required coverage: ${stats.minPct}%`);
  core.info(`Coverage delta: ${stats.deltaPctFmt}%`);

  core.startGroup('Set output values');
  core.setOutput('coverage-pct', stats.current.coverage_pct);
  core.setOutput('package-count', stats.current.pkg_count);
  core.setOutput('uncovered-packages', stats.current.no_tests);

  core.setOutput('coverage-delta', stats.deltaPct);
  core.setOutput('coverage-last-pct', stats.prior.coverage_pct);
  core.setOutput('coverage-last-sha', stats.prior.sha);
  core.setOutput('meets-threshold', stats.meetsThreshold);
  core.setOutput('gocov-pathname', current.gocovPathname);
  core.setOutput('gocov-filtered-pathname', current.gocovFilteredPathname);
  core.setOutput('report-pathname', current.reportPathname);
  core.endGroup();

  const nowData = {
    'go-coverage-action-fmt': DATA_FMT_VERSION,
    'coverage_pct': current.coverage_pct,
    'pkg_stats': current.pkg_stats,
    'skipped_count': current.skipped_count,
  };
  await setCoverageNote(nowData);


  if (!stats.meetsThreshold) {
    const fail_policy = core.getInput('fail-coverage');
    if (fail_policy == 'always' || (fail_policy == 'only_pull_requests' && ctx.payload.pull_request)) {
      core.setFailed(`Code coverage of ${stats.current.coverage_pct}% falls below minimum required coverage of ${stats.minPct}%`);
    } else {
      core.warning(`Code coverage of ${stats.current.coverage_pct}% falls below minimum required coverage of ${stats.minPct}%`);
    }
  }



  const comment = await generatePRComment(stats);
  await core.summary
    .addRaw(comment)
    .write();

  if (core.getBooleanInput('add-comment') && ctx.payload.pull_request) {
    const token = core.getInput('token');
    const octokit = github.getOctokit(token);
    const pr_number = ctx.payload.pull_request.number;
    const prev_comment_id = await findPreviousComment(octokit, pr_number);
    if (prev_comment_id) {
      core.info(`Updating existing comment id ${prev_comment_id}`);
      await octokit.rest.issues.updateComment({
        owner: ctx.payload.repository.owner.login,
        repo: ctx.payload.repository.name,
        comment_id: prev_comment_id,
        body: comment
      });
    } else {
      core.info('Creating new comment');
      await octokit.rest.issues.createComment({
        owner: ctx.payload.repository.owner.login,
        repo: ctx.payload.repository.name,
        issue_number: pr_number,
        body: comment,
      });
    }
  }
}



async function run() {
  try {
    core.info(`Running go-coverage-action version ${version}`);

    await generateReport();
  } catch (e) {
    core.setFailed(e);
  }
}


run();
