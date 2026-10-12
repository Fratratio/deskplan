"""快捷方式体检 / 重建工具（Windows .lnk，纯二进制解析，不依赖 COM）。

用法：
  python tools/shortcut_doctor.py <link.lnk>                    诊断
  python tools/shortcut_doctor.py <link.lnk> --fix --target X   重建（可选 --args/--workdir/--icon）
  python tools/shortcut_doctor.py --platform macos              打印该平台的排查步骤
  python tools/shortcut_doctor.py --platform linux

为什么不用 COM：WScript.Shell 在很多受限环境（CI、沙箱、公司策略）里会被直接拦掉，
而 .lnk 的字段全在二进制里，直接照 MS-SHLLINK 规范读更稳，也不怕目标机没装 PowerShell 模块。

检查项：
  1. 文件本体是否为空 / 是否是伪装成 .lnk 的其它格式
  2. 目标是否存在、是否指向目录（最常见的"双击打开文件夹"根因）
  3. 起始工作目录是否存在
  4. 图标路径是否存在、格式是否被 Windows 支持、是否多档尺寸
  5. 目标是否可执行（扩展名 / PE 头）
"""
import os
import struct
import sys

LINK_CLSID = bytes([0x01, 0x14, 0x02, 0x00, 0, 0, 0, 0,
                    0xC0, 0, 0, 0, 0, 0, 0, 0x46])

FLAG_IDLIST = 0x0001
FLAG_LINKINFO = 0x0002
FLAG_NAME = 0x0004
FLAG_RELPATH = 0x0008
FLAG_WORKDIR = 0x0010
FLAG_ARGS = 0x0020
FLAG_ICON = 0x0040
FLAG_UNICODE = 0x0080

# StringData 出现顺序固定，按 flag 位决定是否读取
STRING_FIELDS = [
    (FLAG_NAME, 'name'),
    (FLAG_RELPATH, 'relPath'),
    (FLAG_WORKDIR, 'workingDir'),
    (FLAG_ARGS, 'args'),
    (FLAG_ICON, 'icon'),
]

ICON_OK_EXT = {'.ico', '.exe', '.dll', '.icl', '.png'}


def u16(v):
    return struct.pack('<H', v)


def u32(v):
    return struct.pack('<I', v)


def ustring(s):
    return u16(len(s)) + s.encode('utf-16-le')


def read_string(blob, pos, unicode_):
    """读一个 CountCharacters 前缀的字符串，返回 (值, 新位置)"""
    n = struct.unpack_from('<H', blob, pos)[0]
    pos += 2
    if unicode_:
        s = blob[pos:pos + n * 2].decode('utf-16-le', 'replace')
        pos += n * 2
    else:
        s = blob[pos:pos + n].decode('mbcs', 'replace')
        pos += n
    return s, pos


def parse_lnk(blob):
    out = {'errors': []}
    if len(blob) < 0x4C:
        out['errors'].append('文件短于 0x4C 字节，几乎肯定不是有效的 .lnk')
        return out
    hs = struct.unpack_from('<I', blob, 0)[0]
    if hs != 0x4C:
        out['errors'].append('HeaderSize=%d（应为 76），结构异常' % hs)
        return out
    if blob[4:20] != LINK_CLSID:
        out['errors'].append('LinkCLSID 不匹配，可能是伪装扩展名的其它文件')

    flags = struct.unpack_from('<I', blob, 0x14)[0]
    out['flags'] = '0x%08x' % flags
    pos = 0x4C

    if flags & FLAG_IDLIST:
        total = struct.unpack_from('<H', blob, pos)[0]
        out['idListSize'] = total
        out['idListNames'] = scan_idlist_names(blob[pos + 2:pos + 2 + total])
        pos += 2 + total

    if flags & FLAG_LINKINFO:
        try:
            size, hdr, lif, vol, basep, net, suf = struct.unpack_from('<7I', blob, pos)
            end = pos + size
            if hdr != 0x1C:
                out['errors'].append('LinkInfoHeaderSize=%d（应为 28）' % hdr)
            if basep and basep < size:
                raw = blob[pos + basep:end].split(b'\x00')[0]
                out['localBasePath'] = raw.decode('mbcs', 'replace')
            if suf and suf < size:
                raw = blob[pos + suf:end].split(b'\x00')[0]
                out['commonSuffix'] = raw.decode('utf-16-le', 'replace')
            pos = end
        except Exception as e:
            out['errors'].append('LinkInfo 解析失败: %s' % e)

    unicode_ = bool(flags & FLAG_UNICODE)
    for bit, key in STRING_FIELDS:
        if flags & bit:
            try:
                out[key], pos = read_string(blob, pos, unicode_)
            except Exception as e:
                out['errors'].append('%s 解析失败: %s' % (key, e))
                break

    out['trailing'] = len(blob) - pos
    return out


ASCII_RUN = __import__('re').compile(r'[A-Za-z0-9_\-\.:\s\\()\[\]@#%&+,;=!]{2,}')


def _item_name(body):
    """从单个 IDList 项里取文件名。

    文件系统项的名称位置随 Windows 版本浮动，直接遍历各偏移取"最长的干净
    ASCII 串"，比猜固定偏移稳。中文目录名在这里会丢，不过那种情况的
    LocalBasePath 通常本来就是对的，不影响判定。
    """
    cands = []
    for off in range(0, min(len(body), 48)):
        raw = body[off:].split(b'\x00')[0]
        try:
            s = raw.decode('mbcs')
        except Exception:
            continue
        m = ASCII_RUN.match(s)
        if m:
            t = m.group().strip()
            if len(t) >= 1:
                cands.append(t)
    return max(cands, key=len) if cands else None


def join_names(parts):
    """把 ['C:\\', 'Program Files', 'Tencent', 'Weixin.exe'] 拼成一条路径。

    只从盘符那一项开始拼，前面那些卷标/CLSID 项会带出乱码，丢掉。
    拼不出盘符就返回空，交回 LocalBasePath 去判。
    """
    start = None
    for i, p in enumerate(parts):
        q = p.strip().strip('/')
        if (len(q) == 2 and q[1] == ':') or (len(q) == 3 and q[1:3] == ':\\'):
            start = i
            break
    if start is None:
        return ''
    out = ''
    for p in parts[start:]:
        q = p.strip().strip('/')
        if not q:
            continue
        if (len(q) == 2 and q[1] == ':') or (len(q) == 3 and q[1:3] == ':\\'):
            out = q if q.endswith('\\') else q + '\\'
        else:
            out = (out.rstrip('\\') + '\\' + q.lstrip('\\')) if out else q
    return out


def scan_idlist_names(data):
    """IDList 里捞可读的名称片段，用于兜底还原目标路径"""
    names, pos = [], 0
    while pos + 2 <= len(data):
        n = struct.unpack_from('<H', data, pos)[0]
        if n == 0:
            break
        body = data[pos + 2:pos + n]
        pos += n
        txt = _item_name(body)
        if txt:
            names.append(txt)
    return names


def check_icon(icon):
    """校验图标：路径、索引语法、格式、尺寸档位"""
    res = {'raw': icon, 'exists': False, 'note': []}
    if not icon:
        res['note'].append('未设置图标位置，会退回目标文件自带的第一个图标')
        return res
    # Windows 允许 "path,index" 语法
    path, _, idx = icon.rpartition(',')
    if path and idx.strip().lstrip('-').isdigit():
        res['iconIndex'] = idx.strip()
        icon = path.strip()
    else:
        icon = path or icon
    res['path'] = icon
    icon = os.path.expandvars(icon.strip('"'))
    res['exists'] = os.path.exists(icon)
    if not res['exists']:
        res['note'].append('图标文件不存在，Windows 会显示白板/占位图标')
        return res
    ext = os.path.splitext(icon)[1].lower()
    res['ext'] = ext
    if ext not in ICON_OK_EXT:
        res['note'].append('扩展名 %s 不能直接当快捷方式图标，需转 .ico 或放进 .exe/.dll 资源' % ext)
        return res
    if ext == '.ico':
        res.update(inspect_ico(icon))
    elif ext == '.png':
        head = open(icon, 'rb').read(8)
        if head != b'\x89PNG\r\n\x1a\n':
            res['note'].append('扩展名是 .png 但内容不是 PNG，图标会显示异常')
    return res


def inspect_ico(path):
    info = {'sizes': []}
    try:
        blob = open(path, 'rb').read()
        res_, type_, n = struct.unpack_from('<HHH', blob, 0)
        if res_ != 0 or type_ != 1:
            info['note'] = ['ICO 头部非法（reserved=%d type=%d），应为空和 1' % (res_, type_)]
            return info
        info['count'] = n
        for i in range(n):
            w, h, cc, rsv, planes, bpp, size, off = struct.unpack_from('<BBBBHHII', blob, 6 + 16 * i)
            info['sizes'].append('%dx%d@%dbpp' % (w or 256, h or 256, bpp))
            if off + size > len(blob):
                info.setdefault('note', []).append(
                    '第 %d 档数据超出文件末尾（off=%d size=%d 文件长=%d）' % (i, off, size, len(blob)))
        if n == 1:
            info.setdefault('note', []).append('只有一档尺寸，缩略图/大图标下会拉伸发虚')
        if not any(s.startswith(('16x16', '20x20', '24x24')) for s in info['sizes']):
            info.setdefault('note', []).append('缺 16/20/24 小档，任务栏和小图标视图会糊')
    except Exception as e:
        info['note'] = ['ICO 解析失败: %s' % e]
    return info


def check_target(target):
    res = {'path': target, 'exists': False}
    if not target:
        res['note'] = ['解析不出目标路径，快捷方式已损坏']
        return res
    t = os.path.expandvars(target.strip('"'))
    res['exists'] = os.path.exists(t)
    if not res['exists']:
        res['note'] = ['目标不存在（应用被移动/卸载，或路径写错）']
        return res
    res['isDir'] = os.path.isdir(t)
    if res['isDir']:
        res['note'] = ['目标是一个目录 → 双击只会打开文件夹，这是"点图标进文件夹"的元凶']
        return res
    ext = os.path.splitext(t)[1].lower()
    res['ext'] = ext
    if ext not in ('.exe', '.com', '.bat', '.cmd', '.msc', '.lnk'):
        res.setdefault('note', []).append(
            '扩展名 %s 不是可执行文件，双击会走"打开方式"而不是启动' % ext)
    if ext == '.exe':
        with open(t, 'rb') as f:
            if f.read(2) != b'MZ':
                res.setdefault('note', []).append('缺少 PE 头（MZ），文件已损坏或不是真正的可执行程序')
    return res


def desktop_dir():
    """定位真实桌面，兼容 OneDrive 重定向"""
    home = os.path.expanduser('~')
    for cand in (os.path.join(home, 'Desktop'),
                 os.path.join(home, 'OneDrive', 'Desktop')):
        if os.path.isdir(cand):
            return cand
    for name in sorted(os.listdir(home)):
        p = os.path.join(home, name, 'Desktop')
        if name.lower().startswith('onedrive') and os.path.isdir(p):
            return p
    return home


class Tee:
    """同时写屏幕和报告文件，报告用 UTF-8，记事本能直接看"""

    def __init__(self, stream, path):
        self.stream = stream
        self.fobj = open(path, 'w', encoding='utf-8')

    def write(self, s):
        self.stream.write(s)
        try:
            self.fobj.write(s)
        except Exception:
            pass

    def flush(self):
        self.stream.flush()
        self.fobj.flush()


def diagnose(path):
    print('=' * 66)
    print('诊断对象:', path)
    print('=' * 66)
    if not os.path.exists(path):
        print('文件不存在'); return None
    size = os.path.getsize(path)
    print('大小: %d 字节' % size)
    blob = open(path, 'rb').read()
    if size == 0:
        print('  0 字节：空文件，必然无效'); return None
    if blob[:4] == b'L\x00\x00\x00':
        pass
    elif blob[:5].lower() == b'<html' or blob.lstrip()[:5].lower() == b'<?xml':
        print('  内容是 HTML/XML：这其实是个 Internet 快捷方式（.url 改名），不是 .lnk')
    elif blob[:4] == b'Rar!' or blob[:2] == b'PK':
        print('  内容是压缩包：扩展名被改错了')

    info = parse_lnk(blob)
    for e in info.get('errors', []):
        print('  [结构错误]', e)

    # 目标候选：LocalBasePath+CommonPathSuffix 优先，不通再试 IDList 还原。
    # 微信这类被官方升级挪过目录的快捷方式，旧路径会留在 LocalBasePath 里，
    # 而 IDList 才是新位置，所以两个候选都要试，谁在磁盘上真实存在就用谁。
    base = (info.get('localBasePath') or '').strip('"')
    suf = (info.get('commonSuffix') or '').strip('"')
    cands = []
    if base and suf:
        cands.append(base.rstrip('\\') + '\\' + suf.lstrip('\\'))
    if base:
        cands.append(base)
    idl = join_names(info.get('idListNames') or [])
    if idl:
        cands.append(idl)
    target = ''
    for c in cands:
        if os.path.exists(os.path.expandvars(c)):
            target = c
            break
    if not target:
        target = cands[0] if cands else ''
    if target and target != (base or '') and idl and target == idl:
        print('  注：LinkInfo 里的旧路径已失效，按 IDList 记录的真实位置判定')

    print('\n--- 字段 ---')
    for k in ('flags', 'localBasePath', 'commonSuffix', 'workingDir', 'args', 'icon', 'idListNames'):
        if k in info:
            print('  %-14s = %s' % (k, info[k]))

    print('\n--- 目标检查 ---')
    t = check_target(target or '')
    print('  目标路径 :', t['path'])
    print('  是否存在 :', t['exists'])
    if t.get('isDir'):
        print('  类型     : 目录（应为文件）')
    for n in t.get('note', []):
        print('  !', n)

    print('\n--- 工作目录检查 ---')
    wd = info.get('workingDir', '')
    print('  起始位置 :', wd or '(空)')
    if not wd:
        print('  ! 未设置。依赖当前目录的程序（Electron/Python/Java 很常见）会找不到资源')
    elif not os.path.isdir(os.path.expandvars(wd)):
        print('  ! 目录不存在，程序可能启动即退')
    else:
        print('  ok')

    print('\n--- 图标检查 ---')
    ic = check_icon(info.get('icon', ''))
    print('  图标位置 :', ic.get('raw') or '(未设置)')
    print('  解析路径 :', ic.get('path', '-'))
    print('  文件存在 :', ic.get('exists'))
    if ic.get('sizes'):
        print('  尺寸档位 :', ', '.join(ic['sizes']))
    for n in ic.get('note', []):
        print('  !', n)

    print('\n--- 结论 ---')
    # 只把"一定会出问题"的判为需修复；未设图标、未设起始位置属于常见正常做法
    bad, warn = [], []
    # IDList 置了标志却是空表（总长只有 2 字节终止符）→ 双击按 IDList 解析落空，
    # 表现是双击毫无反应。这是手写 .lnk 的隐蔽高发坑。
    if info.get('idListSize') is not None and info['idListSize'] <= 2:
        bad.append('目标 IDList 是空表（双击会无反应，需重建）')
    if not t['exists']:
        bad.append('目标不存在')
    elif t.get('isDir'):
        bad.append('目标填成了目录')
    if wd and not os.path.isdir(os.path.expandvars(wd)):
        bad.append('起始位置不存在')
    if ic.get('path') and not ic.get('exists'):
        bad.append('图标文件不存在')
    if ic.get('ext') and ic['ext'] not in ICON_OK_EXT:
        bad.append('图标格式不支持')
    for n in ic.get('note', []):
        if 'ICO 头部非法' in n or '超出文件末尾' in n:
            bad.append('图标内容损坏')

    if not wd:
        warn.append('未设起始位置（多数程序不受影响）')
    if not ic.get('raw'):
        warn.append('未设图标位置（会用程序自带图标）')
    for n in ic.get('note', []):
        if '小档' in n or '只有一档' in n:
            warn.append(n)

    if bad:
        print('  需要修复:', ' / '.join(bad))
        print('  建议: 用 --fix 重建，或直接运行 tools/make_shortcut.py')
    else:
        print('  目标 / 起始位置 / 图标 均正常。若仍点不开，问题在程序本身或权限。')
    for w in warn:
        print('  提示:', w)
    return info, bad


def build_idlist(target):
    """用系统 shell API 生成目标的真实 IDList。

    空 IDList + FLAG_IDLIST 会导致双击无反应（Windows 优先按 IDList 解析目标），
    拿不到真实 PIDL 时宁可去掉 FLAG_IDLIST 只留 LinkInfo——这也是合法写法。
    """
    pidl = ctypes.c_void_p()
    ret = ctypes.WinDLL('shell32', use_last_error=True).SHParseDisplayName(str(target), None, ctypes.byref(pidl), 0, None)
    if ret != 0 or not pidl.value:
        return None
    try:
        size = ctypes.WinDLL('shell32', use_last_error=True).ILGetSize(pidl)
        return bytes((ctypes.c_ubyte * size).from_address(pidl.value))
    finally:
        ctypes.WinDLL('ole32', use_last_error=True).CoTaskMemFree(pidl)


def rebuild(path, target, args='', workdir='', icon=''):
    """按 MS-SHLLINK 重建一个干净的 .lnk"""
    if not target:
        print('缺少 --target'); return 1
    target = os.path.abspath(os.path.expandvars(target))
    workdir = os.path.abspath(os.path.expandvars(workdir or os.path.dirname(target)))
    flags = (FLAG_LINKINFO | FLAG_WORKDIR | FLAG_ARGS | FLAG_ICON | FLAG_UNICODE)
    idlist = build_idlist(target)
    if idlist:
        flags |= FLAG_IDLIST
    header = (u32(0x4C) + LINK_CLSID + u32(flags) + u32(0x20)
              + b'\x00' * 24 + u32(0) + u32(0) + u32(1)
              + u16(0) + u16(0) + u32(0) + u32(0))
    body = (u16(len(idlist)) + idlist) if idlist else b''
    volume_id = u32(0x11) + u32(3) + u32(0) + u32(0x10) + b'\x00'
    # 关键：LocalBasePath 必须是目标文件本体，填目录会被解析成文件夹
    base = target.encode('mbcs') + b'\x00'
    base_off = 0x1C + len(volume_id)
    suffix_off = base_off + len(base)
    link_info = (u32(suffix_off + 1) + u32(0x1C) + u32(0x1)
                 + u32(0x1C) + u32(base_off) + u32(0) + u32(suffix_off)
                 + volume_id + base + b'\x00')
    strings = ustring(workdir) + ustring(args) + ustring(icon)
    blob = header + body + link_info + strings

    bak = path + '.bak'
    if os.path.exists(path):
        os.replace(path, bak)
        print('原文件已备份为:', bak)
    with open(path, 'wb') as f:
        f.write(blob)
    print('已重建:', path)
    return diagnose(path) is not None and 0


PLATFORM_HELP = {
    'macos': """
macOS 排查顺序
  1. 判断图标类型：右键"显示简介"，或用命令看节点类型
       ls -l@ ~/Desktop/你的应用
       file ~/Desktop/你的应用
     - 以 .app 结尾且是目录 → 应用包
     - ls -l 显示 "xxx -> /path" → 符号链接
     - 显示 "alias" 扩展属性 → Finder 别名
  2. 应用包打不开，最常见是 Gatekeeper 隔离属性：
       xattr -l /Applications/xxx.app
       sudo xattr -dr com.apple.quarantine /Applications/xxx.app
  3. 可执行权限缺失（自己打包的脚本/二进制常见）：
       chmod +x /Applications/xxx.app/Contents/MacOS/*
  4. 签名损坏（"已损坏，无法打开"）：
       codesign -vvv --deep /Applications/xxx.app
       重新签名：codesign --force --deep --sign - /Applications/xxx.app
  5. 图标不显示：应用包内需有 Contents/Resources/xxx.icns，
     且 Contents/Info.plist 的 CFBundleIconFile 指向它；
     重建图标缓存：sudo rm -rf /Library/Caches/com.apple.iconservices.store && killall Finder
  6. 重建入口（推荐用别名，Finder 里能正常显示图标）：
       ln -s /Applications/xxx.app ~/Desktop/xxx        （符号链接）
       或在 Finder 里对 .app 按 Cmd+Option 拖拽 = 创建别名
       拖到 Dock 用 ln -s 后需 killall Dock
""",
    'linux': """
Linux 排查顺序（绝大多数发行版走 XDG .desktop）
  1. 看文件是不是合法的 desktop entry：
       ls -l ~/Desktop/xxx.desktop
       desktop-file-validate ~/Desktop/xxx.desktop      （没装就 apt install desktop-file-utils）
  2. 常见三项硬伤：
       - Exec= 路径不存在，或没写绝对路径
       - Path= 未设置，程序依赖当前目录会启动即退
       - 文件没有可执行位 → GNOME 会提示"未受信任"
       chmod +x ~/Desktop/xxx.desktop
       gio set ~/Desktop/xxx.desktop metadata::trusted true
  3. 图标不显示：
       Icon= 写绝对路径最稳；写图标名的话要放进 ~/.local/share/icons 或 /usr/share/icons
       刷新缓存：update-desktop-database ~/.local/share/applications ; killall nautilus
  4. AppImage：需先 chmod +x，且 sandbox 环境常缺 FUSE
       chmod +x xxx.AppImage && ./xxx.AppImage --appimage-extract-and-run
  5. 重建入口：
       cp /usr/share/applications/xxx.desktop ~/Desktop/ && chmod +x ~/Desktop/xxx.desktop
       或用 xdg-desktop-icon install --novendor /usr/share/applications/xxx.desktop
       无桌面图标支持的会话（纯 i3/Hyprland）需改走 rofi/ulauncher，桌面图标本身不生效
""",
}


def scan_desktop():
    """扫一遍桌面上所有 .lnk，最后给一张汇总"""
    import glob
    desk = desktop_dir()
    links = sorted(glob.glob(os.path.join(desk, '*.lnk')))
    print('桌面目录:', desk)
    print('找到快捷方式: %d 个\n' % len(links))
    if not links:
        print('桌面上没有 .lnk。若图标能显示却扫不到，多半是 .url 或别名，'
              '把文件拖进本脚本即可单独诊断。')
        return 0
    bad_list = []
    for p in links:
        info, bad = diagnose(p)
        print()
        if bad:
            bad_list.append((os.path.basename(p), bad))
    print('=' * 66)
    print('汇总')
    print('=' * 66)
    if not bad_list:
        print('全部 %d 个快捷方式的 目标 / 起始位置 / 图标 均正常。' % len(links))
        print('若某个图标仍点不开或显示空白，问题在程序本体或权限，手动运行目标看报错。')
    else:
        for name, bad in bad_list:
            print('  需要修复: %-40s %s' % (name, ' / '.join(bad)))
        print('\n修复办法见 docs/快捷方式故障排查与重建指南.md 第 5 节。')
    return 0


def main():
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        return 0
    if '--out' in argv:
        idx = argv.index('--out')
        if idx + 1 < len(argv):
            os.makedirs(os.path.dirname(argv[idx + 1]) or '.', exist_ok=True)
            sys.stdout = Tee(sys.stdout, argv[idx + 1])
            del argv[idx:idx + 2]
    if argv and argv[0] == '--scan-desktop':
        return scan_desktop()
    if argv and argv[0] == '--platform' and len(argv) > 1:
        print(PLATFORM_HELP.get(argv[1], '支持: macos / linux'))
        return 0
    if not argv:
        print(__doc__)
        return 0

    path = argv[0]
    if '--fix' in argv:
        def opt(name, default=''):
            return argv[argv.index(name) + 1] if name in argv else default
        return rebuild(path, opt('--target'), opt('--args'),
                       opt('--workdir'), opt('--icon'))
    diagnose(path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
