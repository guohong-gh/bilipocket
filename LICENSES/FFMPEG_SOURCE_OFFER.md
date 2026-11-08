# FFmpeg 对应源码与书面要约（GPL-3.0）

BiliPocket 随包分发的 `ffmpeg-x86_64-pc-windows-msvc.exe` 是 **GPL-3.0** 构建。按 GPL 第 3 版第 6 条，分发二进制时须同时提供或书面承诺提供其完整对应源码。本文件即为该说明与书面要约。

## 分发的二进制

| 项目 | 值 |
|---|---|
| 文件 | `ffmpeg-x86_64-pc-windows-msvc.exe` |
| 版本 | `7.1-essentials_build-www.gyan.dev`（Copyright (c) 2000-2024 the FFmpeg developers） |
| 构建来源 | gyan.dev essentials build，<https://www.gyan.dev/ffmpeg/builds/> |
| SHA-256 | `2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3` |
| 许可 | GNU General Public License v3，全文见 [`FFmpeg-GPL-3.0.txt`](FFmpeg-GPL-3.0.txt) |
| 是否修改 | 未修改，按上游原样分发 |

## 对应源码

- 上游源码：FFmpeg 7.1 发布版源码包 —— <https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz>
- 该二进制的完整 `configure` 参数（取自 `ffmpeg -version` 原样输出，决定「对应源码」的编译配置）：

```text
--enable-gpl --enable-version3 --enable-static --disable-w32threads --disable-autodetect
--enable-fontconfig --enable-iconv --enable-gnutls --enable-libxml2 --enable-gmp --enable-bzlib
--enable-lzma --enable-zlib --enable-libsrt --enable-libssh --enable-libzmq --enable-avisynth
--enable-sdl2 --enable-libwebp --enable-libx264 --enable-libx265 --enable-libxvid --enable-libaom
--enable-libopenjpeg --enable-libvpx --enable-mediafoundation --enable-libass --enable-libfreetype
--enable-libfribidi --enable-libharfbuzz --enable-libvidstab --enable-libvmaf --enable-libzimg
--enable-amf --enable-cuda-llvm --enable-cuvid --enable-dxva2 --enable-d3d11va --enable-d3d12va
--enable-ffnvcodec --enable-libvpl --enable-nvdec --enable-nvenc --enable-vaapi --enable-libgme
--enable-libopenmpt --enable-libopencore-amrwb --enable-libmp3lame --enable-libtheora
--enable-libvo-amrwbenc --enable-libgsm --enable-libopencore-amrnb --enable-libopus --enable-libspeex
--enable-libvorbis --enable-librubberband
```

- 构建工具链：gcc 14.2.0（MSYS2 项目），静态链接。上游构建说明见 gyan.dev 构建页；该二进制未做任何改动，因此「对应源码」即上游 7.1 源码 + 上述配置。

## 书面要约

任何收到本软件的人，可在 **三年内** 通过本仓库 issue 索取上述对应源码的副本（含上述构建配置与构建说明），将免费提供，仅收取传递所需的成本。索取入口：<https://github.com/guohong-gh/bilipocket/issues>

## 边界说明

- FFmpeg 以**独立进程**方式被调用，不与 BiliPocket 的 MIT 源码链接或静态合并，因此不改变 BiliPocket 自身的许可。
- H.264 / AAC 等编解码器的**专利**许可与 GPL 是两件事，由分发者自行负责；本文件不构成专利授权。
- 若后续改用 LGPL 构建，本文件随之作废，并在 `THIRD_PARTY.md` 中说明。
