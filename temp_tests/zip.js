/* ============================================================
   最小 ZIP 写入器（deflate）
   不依赖系统 zip 命令：Windows 上 tar/zip 的路径与盘符转义问题
   太多，且商店上传只需要一个标准 zip。
   ============================================================ */
const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * @param {Array<{name: string, data: Buffer}>} entries
 * @param {string} outPath
 * 时间戳固定为 1980-01-01：同样的输入必须产出字节一致的 zip，
 * 否则「构建产物是否变化」无法用哈希判断。
 */
function writeZip(entries, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    local.writeUInt16LE(20, 4);          // 解压所需版本
    local.writeUInt16LE(0x0800, 6);      // 通用标志：文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // 修改时间
    local.writeUInt16LE(0x21, 12);       // 修改日期（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // 中央目录签名
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);            // extra
    dir.writeUInt16LE(0, 32);            // comment
    dir.writeUInt16LE(0, 34);            // 磁盘号
    dir.writeUInt16LE(0, 36);            // 内部属性
    dir.writeUInt32LE(0, 38);            // 外部属性
    dir.writeUInt32LE(offset, 42);       // 本地头偏移
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // 中央目录结束记录
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, end]));
  return fs.statSync(outPath).size;
}

module.exports = { writeZip, crc32 };