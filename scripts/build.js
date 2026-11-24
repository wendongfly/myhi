import { execSync } from 'child_process';
import { copyFileSync, mkdirSync, existsSync, renameSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function run(cmd) {
  console.log('>', cmd);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

// 1. Bundle server with ncc
// --license：把打进 bundle 的依赖的许可证全文汇总到 dist/THIRD_PARTY_LICENSES.txt（MIT 等许可证要求随附）
run('npx ncc build src/server.js -o dist -m --external node-pty --license THIRD_PARTY_LICENSES.txt');

// 2. Bundle attach client
run('npx ncc build src/attach.js -o dist/attach-tmp -m');
if (existsSync(join(root, 'dist/attach-tmp/index.js'))) {
  renameSync(join(root, 'dist/attach-tmp/index.js'), join(root, 'dist/attach.js'));
  try {
    const { rmSync } = await import('fs');
    rmSync(join(root, 'dist/attach-tmp'), { recursive: true });
  } catch {
    execSync(`rm -rf dist/attach-tmp`, { cwd: root });
  }
}

// 3. Copy public assets
const publicFiles = ['chat.html', 'index.html', 'grid.html', 'studio.html', 'minutes.html', 'terminal.html', 'login.html', 'admin.html', 'icon.png', 'icon.svg', 'manifest.json'];
for (const f of publicFiles) {
  const src = join(root, 'public', f);
  if (existsSync(src)) copyFileSync(src, join(root, 'dist', f));
}
// 前端第三方库（ansi_up / xterm 等），server 以 /lib 静态托管；漏拷则新机器构建出的页面缺依赖白屏
const { cpSync } = await import('fs');
const libSrc = join(root, 'public', 'lib');
if (existsSync(libSrc)) cpSync(libSrc, join(root, 'dist', 'lib'), { recursive: true });
// xterm 及两个插件：从 node_modules 只拷页面用到的文件 + LICENSE（以前整包提交进 public/lib，
// 带着 TypeScript 源码 / sourcemap / 测试产物 130 多个文件、近 3MB，全都用不上）
for (const [pkg, dst, files] of [
  ['xterm', 'xterm', ['lib/xterm.js', 'css/xterm.css', 'LICENSE']],
  ['xterm-addon-fit', 'xterm-fit', ['lib/xterm-addon-fit.js', 'LICENSE']],
  ['xterm-addon-web-links', 'xterm-links', ['lib/xterm-addon-web-links.js', 'LICENSE']],
]) {
  for (const rel of files) {
    const from = join(root, 'node_modules', pkg, rel);
    if (!existsSync(from)) throw new Error(`缺少 ${pkg}/${rel}：先 npm install（xterm 在 devDependencies 里）`);
    const to = join(root, 'dist', 'lib', dst, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

// 页面预压缩：server 对支持 gzip 的浏览器直接发 .gz（chat.html 490KB → 约 130KB），网络差时首屏快很多
{
  const { gzipSync } = await import('zlib');
  const { readFileSync, writeFileSync } = await import('fs');
  for (const f of publicFiles.filter((x) => x.endsWith('.html'))) {
    const p = join(root, 'dist', f);
    if (existsSync(p)) writeFileSync(p + '.gz', gzipSync(readFileSync(p), { level: 9 }));
  }
}

// 3b. 纪要录音转码的 worker（.amr → WAV）：worker_threads 按文件路径加载，ncc 打不进 index.js，原样拷过去
mkdirSync(join(root, 'dist', 'vendor'), { recursive: true });
copyFileSync(join(root, 'src', 'amr-worker.cjs'), join(root, 'dist', 'amr-worker.cjs'));
copyFileSync(join(root, 'src', 'vendor', 'amrnb.cjs'), join(root, 'dist', 'vendor', 'amrnb.cjs'));

// 4. Copy builtin skills
const { readdirSync } = await import('fs');
const builtinSrc = join(root, 'src', 'builtin-skills');
const builtinDst = join(root, 'dist', 'builtin-skills');
if (existsSync(builtinSrc)) {
  mkdirSync(builtinDst, { recursive: true });
  for (const f of readdirSync(builtinSrc)) {
    copyFileSync(join(builtinSrc, f), join(builtinDst, f));
  }
}

// 5. 构建信息：发布时没重新构建（dist 是旧的）一眼能看出来——server 启动时比对版本号，不一致就告警
{
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  let commit = '';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch {}
  writeFileSync(join(root, 'dist', 'build-info.json'), JSON.stringify({ version, commit, builtAt: new Date().toISOString() }, null, 2));
  console.log(`  构建信息：v${version}${commit ? ' · ' + commit : ''}`);
}

console.log('\n✓ 构建完成');
