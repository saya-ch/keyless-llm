"""生成与 ccgo2dsapi.lnk 同形态的 Windows 快捷方式（MS-SHLLINK）。

做法：复用参考 lnk 的 ShellLinkHeader + LinkTargetIDList（目标同为 powershell.exe），
按规范重写 StringData（名称/相对路径/工作目录/参数/图标），末尾接空 TerminalBlock。
不依赖 COM / 第三方库。
"""
import struct
import sys

TEMPLATE = r"C:\Users\20655\Desktop\ccgo2dsapi.lnk"


def u16(b, o):
    return struct.unpack_from("<H", b, o)[0]


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def rfind_extradata(d):
    """定位 ExtraData 起始偏移：跳过 header / IDList / LinkInfo / StringData。"""
    flags = u32(d, 0x14)
    o = 0x4C
    if flags & 0x00000001:
        o += 2 + u16(d, o)
    if flags & 0x00000002:
        o += u32(d, o)
    for bit in (0x00000004, 0x00000008, 0x00000010, 0x00000020, 0x00000040):
        if flags & bit:
            o += 2 + u16(d, o) * 2
    return o


def build(template, workdir, script, name, icon, out_path):
    d = open(template, "rb").read()
    if u32(d, 0) != 0x4C:
        raise SystemExit("template is not a shell link")

    flags = u32(d, 0x14)
    header = bytearray(d[:0x4C])

    # IDList：原样复用（0x4C 处的 ushort 是 IDList 总长）
    idl_size = u16(d, 0x4C)
    idlist = d[0x4C: 0x4C + 2 + idl_size]

    # 目标与参数
    args = '-NoProfile -ExecutionPolicy Bypass -File "%s"' % script
    # 相对路径：lnk 位于桌面，powershell.exe 在 C:\Windows\System32\...（与参考一致）
    rel_path = r"..\..\..\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"

    strings = [
        (name, 0x00000004),          # NAME_STRING
        (rel_path, 0x00000008),      # RELATIVE_PATH
        (workdir, 0x00000010),       # WORKING_DIR
        (args, 0x00000020),          # COMMAND_LINE_ARGUMENTS
        (icon, 0x00000040),          # ICON_LOCATION
    ]

    # StringData 条目与模板完全一致（5 项），因此直接沿用模板的 LinkFlags，
    # 保证生成的快捷方式与 Windows 自己创建的同形态（含 HasExpIcon 位）。
    need = flags
    struct.pack_into("<I", header, 0x14, need)

    body = bytearray()
    for text, _ in strings:
        body += struct.pack("<H", len(text))
        body += text.encode("utf-16-le")

    # ExtraData：原样沿用参考的块（IconEnvironment 指向同一个 powershell.exe，
    # 另含 SpecialFolder / KnownFolder(桌面) / PropertyStore），
    # 这样生成的文件与「Windows 自己创建的快捷方式」结构一致。
    tail = d[rfind_extradata(d):]
    body += tail

    blob = bytes(header) + idlist + bytes(body)
    open(out_path, "wb").write(blob)
    return len(blob)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\20655\Desktop\keyless-llm.lnk"
    workdir = r"C:\workspace\keyless-llm"
    script = workdir + r"\launch.ps1"
    name = "Start Keyless LLM Gateway (closing the window stops it)"
    icon = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    n = build(TEMPLATE, workdir, script, name, icon, out)
    print("written:", out, n, "bytes")
