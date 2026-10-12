"""在桌面生成「桌边 DeskPlan」快捷方式。

不依赖 COM / WScript（沙箱里会被拦），直接按 MS-SHLLINK 规范写 .lnk：
  ShellLinkHeader + LinkTargetIDList + LinkInfo + StringData
写完立刻回读校验一遍，确保字段没写歪。

关键修正：LinkInfo 里的 LocalBasePath 必须指向"目标文件本体"（electron.exe），
不能填工作目录——之前填的是 app 目录，Windows 就把这个快捷方式解析成了文件夹，
于是双击只是打开目录，图标也退化成默认的文件夹图。
"""
import ctypes
import os
import struct
import sys

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
ICON = os.path.join(APP_DIR, 'assets', 'app.ico')

LINK_CLSID = bytes([0x01, 0x14, 0x02, 0x00, 0, 0, 0, 0,
                    0xC0, 0, 0, 0, 0, 0, 0, 0x46])

FLAG_IDLIST = 0x0001
FLAG_LINKINFO = 0x0002
FLAG_WORKDIR = 0x0010
FLAG_ARGS = 0x0020
FLAG_ICON = 0x0040
FLAG_UNICODE = 0x0080


def u16(v):
    return struct.pack('<H', v)


def u32(v):
    return struct.pack('<I', v)


def ustring(s):
    """StringData：CountCharacters(2) + UTF-16LE，不含结尾空字符"""
    return u16(len(s)) + s.encode('utf-16-le')


def build_idlist(target):
    """用系统 shell API 生成目标的真实 IDList。

    关键教训：IDList 只能是空表或合法表，绝不能设了 FLAG_IDLIST 又塞一张空表——
    Windows 双击时优先按 IDList 解析目标，空表会把目标解析成"什么都没有"，
    表现就是双击毫无反应（LocalBasePath 写得再对也不看）。
    """
    pidl = ctypes.c_void_p()
    ret = ctypes.WinDLL('shell32', use_last_error=True).SHParseDisplayName(str(target), None, ctypes.byref(pidl), 0, None)
    if ret != 0 or not pidl.value:
        return None
    try:
        # ILGetSize: 取完整 PIDL 字节（含终止项）
        size = ctypes.WinDLL('shell32', use_last_error=True).ILGetSize(pidl)
        buf = (ctypes.c_ubyte * size).from_address(pidl.value)
        return bytes(buf)
    finally:
        ctypes.WinDLL('ole32', use_last_error=True).CoTaskMemFree(pidl)


def build_lnk(target, args, workdir, icon):
    idlist = build_idlist(target)
    flags = FLAG_LINKINFO | FLAG_WORKDIR | FLAG_ARGS | FLAG_ICON | FLAG_UNICODE
    if idlist:
        flags |= FLAG_IDLIST

    header = (u32(0x4C) + LINK_CLSID + u32(flags) + u32(0x20)
              + b'\x00' * 24          # 三个 FILETIME
              + u32(0)                # FileSize
              + u32(0)                # IconIndex
              + u32(1)                # ShowCommand = SW_SHOWNORMAL
              + u16(0) + u16(0) + u32(0) + u32(0))

    body = b''
    if idlist:
        body += u16(len(idlist)) + idlist

    # 固定盘、无卷标：VolumeLabelOffset 指到结构末尾那个空字符，保证是个合法的空串
    volume_id = u32(0x11) + u32(3) + u32(0) + u32(0x10) + b'\x00'
    # LocalBasePath 必须是目标文件本体（electron.exe）；填工作目录会被解析成文件夹
    base = target.encode('mbcs') + b'\x00'
    base_off = 0x1C + len(volume_id)
    suffix_off = base_off + len(base)
    link_info = (u32(suffix_off + 1) + u32(0x1C) + u32(0x1)
                 + u32(0x1C) + u32(base_off) + u32(0) + u32(suffix_off)
                 + volume_id + base + b'\x00')

    strings = ustring(workdir) + ustring(args) + ustring(icon)
    return header + body + link_info + strings


def parse_lnk(blob):
    """回读校验：把关键字段解出来"""
    assert len(blob) >= 0x4C, '文件太短'
    assert struct.unpack_from('<I', blob, 0)[0] == 0x4C, 'HeaderSize 不对'
    assert blob[4:20] == LINK_CLSID, 'CLSID 不对'
    flags = struct.unpack_from('<I', blob, 0x14)[0]
    pos = 0x4C
    out = {'flags': hex(flags)}
    if flags & FLAG_IDLIST:
        idl = struct.unpack_from('<H', blob, pos)[0]
        pos += 2 + idl
        out['idlist'] = idl
    if flags & FLAG_LINKINFO:
        size, hdr, lif, vol, basep, net, suf = struct.unpack_from('<7I', blob, pos)
        assert hdr == 0x1C, 'LinkInfoHeaderSize 不对'
        end = pos + size
        out['linkInfoSize'] = size
        out['localBasePath'] = blob[pos + basep:end].split(b'\x00')[0].decode('mbcs', 'replace')
        pos = end
    for name in ('workingDir', 'args', 'icon'):
        n = struct.unpack_from('<H', blob, pos)[0]
        pos += 2
        s = blob[pos:pos + n * 2].decode('utf-16-le')
        pos += n * 2
        out[name] = s
    out['consumed'] = (pos, len(blob))
    return out


def desktop_dir():
    home = os.path.expanduser('~')
    for cand in (os.path.join(home, 'Desktop'),
                 os.path.join(home, 'OneDrive', 'Desktop')):
        if os.path.isdir(cand):
            return cand
    # OneDrive 带后缀的情况
    for name in sorted(os.listdir(home)):
        p = os.path.join(home, name, 'Desktop')
        if name.lower().startswith('onedrive') and os.path.isdir(p):
            return p
    return home


def resolve_target():
    """优先指向打包版，其次退回开发态的 electron.exe。

    打包版（release\\win-unpacked\\桌边 DeskPlan.exe）体验完全不同：
    有独立图标、独立的用户数据目录、卸载入口，装了包就该指它。
    """
    packed = os.path.join(APP_DIR, 'release', 'win-unpacked', '桌边 DeskPlan.exe')
    if os.path.exists(packed):
        return packed, ''            # 目标自带参数，不要再传 app 目录
    return ELECTRON, '"%s"' % APP_DIR


def main():
    target, args = resolve_target()
    if not os.path.exists(target):
        print('找不到可执行文件：', target)
        print('先跑 npm run dist 生成安装包，或 npm install 装 electron。')
        return 1
    icon = os.path.join(APP_DIR, 'assets', 'app.ico')
    blob = build_lnk(target, args, os.path.dirname(target),
                     icon if os.path.exists(icon) else '')
    info = parse_lnk(blob)

    desk = desktop_dir()
    path = os.path.join(desk, '桌边 DeskPlan.lnk')
    with open(path, 'wb') as f:
        f.write(blob)
    print('桌面目录:', desk)
    print('快捷方式:', path)
    print('指向    :', target, args)
    for k, v in info.items():
        print('  ', k, '=', v)
    return 0


if __name__ == '__main__':
    sys.exit(main())
