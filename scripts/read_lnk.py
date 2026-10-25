"""按 MS-SHLLINK 规范解析 .lnk，输出关键字段。用于读取参考快捷方式与自校验。"""
import struct
import sys


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def parse(path):
    d = open(path, "rb").read()
    out = {"_size": len(d)}
    if u32(d, 0) != 0x4C:
        raise SystemExit("not a shell link: header size = %#x" % u32(d, 0))
    flags = u32(d, 0x14)
    names = [
        (0x00000001, "HasLinkTargetIDList"),
        (0x00000002, "HasLinkInfo"),
        (0x00000004, "HasName"),
        (0x00000008, "HasRelativePath"),
        (0x00000010, "HasWorkingDir"),
        (0x00000020, "HasArguments"),
        (0x00000040, "HasIconLocation"),
        (0x00000080, "IsUnicode"),
    ]
    out["flags"] = " ".join(n for bit, n in names if flags & bit)
    out["flags_hex"] = hex(flags)
    out["show_command"] = u32(d, 0x3C)
    out["icon_index"] = struct.unpack_from("<i", d, 0x38)[0]

    o = 0x4C
    if flags & 0x00000001:  # LinkTargetIDList
        idl_size = struct.unpack_from("<H", d, o)[0]
        out["idlist_size"] = idl_size
        o += 2 + idl_size

    if flags & 0x00000002:  # LinkInfo
        li_start = o
        li_size = u32(d, o)
        li_hdr = u32(d, o + 4)
        li_flags = u32(d, o + 8)
        out["linkinfo_size"] = li_size
        out["linkinfo_flags"] = hex(li_flags)
        if li_flags & 1:  # VolumeIDAndLocalBasePath
            vol_off = u32(d, o + 12)
            lbp_off = u32(d, o + 16)
            cps_off = u32(d, o + 24)
            vol = d[li_start + vol_off: li_start + li_size].split(b"\x00")[0]
            lbp = d[li_start + lbp_off: li_start + li_size].split(b"\x00")[0]
            cps = d[li_start + cps_off: li_start + li_size].split(b"\x00")[0]
            out["volume_label"] = vol.decode("mbcs", "replace")
            out["local_base_path"] = lbp.decode("mbcs", "replace")
            out["common_path_suffix"] = cps.decode("mbcs", "replace")
            out["drive_type"] = u32(d, li_start + vol_off + 4)
            out["drive_serial"] = hex(u32(d, li_start + vol_off + 8))
        o = li_start + li_size

    order = [
        (0x00000004, "NAME_STRING"),
        (0x00000008, "RELATIVE_PATH"),
        (0x00000010, "WORKING_DIR"),
        (0x00000020, "COMMAND_LINE_ARGUMENTS"),
        (0x00000040, "ICON_LOCATION"),
    ]
    for bit, label in order:
        if not (flags & bit):
            continue
        n = struct.unpack_from("<H", d, o)[0]
        o += 2
        raw = d[o: o + n * 2]
        o += n * 2
        out[label] = raw.decode("utf-16-le", "replace")

    out["_stringdata_end"] = o
    return out


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\20655\Desktop\ccgo2dsapi.lnk"
    info = parse(target)
    for k, v in info.items():
        print(f"{k:22s} = {v!r}")
