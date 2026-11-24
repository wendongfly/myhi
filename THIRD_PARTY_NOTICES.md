# Third-party notices

myhi itself is released under the MIT License (see `LICENSE`). It includes or redistributes the following third-party software.

## Vendored in this repository / copied at build time

| Component | Version | License | Location | Copyright |
|---|---|---|---|---|
| xterm.js | 4.19.0 | MIT | copied from npm into `dist/lib/xterm/` at build time (license file included) | Copyright (c) 2017-2019 The xterm.js authors; 2014-2016 SourceLair Private Company; 2012-2013 Christopher Jeffrey |
| xterm-addon-fit | 0.5.0 | MIT | copied into `dist/lib/xterm-fit/` at build time (license file included) | The xterm.js authors |
| xterm-addon-web-links | 0.6.0 | MIT | copied into `dist/lib/xterm-links/` at build time (license file included) | The xterm.js authors |
| ansi_up | 6.0.6 | MIT | `public/lib/ansi_up.js` | Copyright (c) 2011 Dru Nelson |
| Feather icons (SVG paths) | — | MIT | `public/lib/icons.js` | Copyright (c) 2013-2017 Cole Bemis |
| benz-amr-recorder (AMR decoder part, `amrnb.js`) | 1.1.5 | MIT | `src/vendor/amrnb.cjs` | Copyright (c) 2017 BenzLeung |
| opencore-amr (compiled to asm.js inside `amrnb.js`) | — | Apache License 2.0 | `src/vendor/amrnb.cjs` | Copyright (C) 2009 The Android Open Source Project; contains code derived from the 3GPP AMR reference implementation |

The full text of the Apache License 2.0 is in `licenses/Apache-2.0.txt`.

## Bundled into the npm package

`dist/index.js` is built with [@vercel/ncc](https://github.com/vercel/ncc) and bundles runtime dependencies (express, socket.io, multer, qrcode, selfsigned and their dependencies). Their license texts are collected at build time into `dist/THIRD_PARTY_LICENSES.txt`. As of this release none of them is GPL/AGPL-licensed (node-forge is dual-licensed BSD-3-Clause OR GPL-2.0 and is used under BSD-3-Clause).

`node-pty` (MIT) and `socket.io-client` (MIT) are installed as regular npm dependencies.

## MIT License text (applies to the MIT components above)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
