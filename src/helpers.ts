export function getLEUint32(data: Uint8Array, offset: number = 0){
    return  (data[offset+0] << 0) |
            (data[offset+1] << 8) |
            (data[offset+2] << 16) |
            (data[offset+3] << 24);
}

export function getBEUint32(data: Uint8Array, offset: number = 0){
    return  (data[offset+3] << 0) |
            (data[offset+2] << 8) |
            (data[offset+1] << 16) |
            (data[offset+0] << 24);
}

export function getLEUint32AsBytes(num: number){
    return [(num >> 0) & 0xFF, (num >> 8) & 0xFF, (num >> 16) & 0xFF, (num >> 24) & 0xFF];
}

export function getBEUint32AsBytes(num: number){
    return [(num >> 24) & 0xFF, (num >> 16) & 0xFF, (num >> 8) & 0xFF, (num >> 0) & 0xFF];
}

export function getBEUint16AsBytes(num: number){
    return [(num >> 8) & 0xFF, (num >> 0) & 0xFF];
}

export function getNthPartitionFromMBR(mbrSector: Uint8Array, n: number){
    return {
        firstLBA: getLEUint32(mbrSector, 0x01BE + 0x10 * n + 8),
        sectorCount: getLEUint32(mbrSector, 0x01BE + 0x10 * n + 12),
    }
}

export function dumpHex(data: Uint8Array){
    for(let line = 0; line < data.length / 16; line++){
        const head = (line * 16).toString(16).padStart(8, '0');
        const contentBytes = [...data.subarray(line * 16, line * 16 + 16)];
        const content = contentBytes.map(e => e.toString(16).padStart(2, '0')).join(' ');
        const footer = contentBytes.map(e => (e >= 0x20 && e <= 0x7F) ? e : '.'.charCodeAt(0)).map(e => String.fromCharCode(e)).join('');
        console.log(`${head}\t${content}\t${footer}`);
    }
}