import { Mutex } from "async-mutex";
import { getBEUint16AsBytes, getBEUint32, getBEUint32AsBytes, getLEUint32, getLEUint32AsBytes, getNthPartitionFromMBR } from "./helpers";

export class MassStorageError extends Error{
    constructor(message: string){
        super("Mass Storage Driver Error: " + message);
    }
}

interface CBW {
    dCBWTag: number;
    dDBWDataTransferLength: number;
    bmCBWFlags: number;
    bCBWLUN: number;
    bCBWCBLength?: number;
    CBWCB: Uint8Array;
}

interface CSW {
    dCSWTag: number;
    dCSWDataResidue: number;
    bCSWStatus: number;
}


function deserializeCSW(data: Uint8Array): CSW{
    return {
        dCSWTag: getLEUint32(data, 4),
        bCSWStatus: data[12],
        dCSWDataResidue: getLEUint32(data, 8),
    };
}

function serializeCBW(cbw: CBW) {
    if(cbw.bCBWCBLength === undefined){
        cbw.bCBWCBLength = CDB_LEN_TABLE[cbw.CBWCB[0]];
    }
    return new Uint8Array([
        0x55, 0x53, 0x42, 0x43, // dCBWSignature = 'USBC'
        ...getLEUint32AsBytes(cbw.dCBWTag),
        ...getLEUint32AsBytes(cbw.dDBWDataTransferLength),
        cbw.bmCBWFlags,
        cbw.bCBWLUN,
        cbw.bCBWCBLength,
        ...cbw.CBWCB,
    ]);
}

function deserializeCBW(data: Uint8Array): CBW{
    if(
        data[0] !== 0x55 ||
        data[1] !== 0x53 ||
        data[2] !== 0x42 ||
        data[3] !== 0x43
    ) throw new MassStorageError("Invalid magic in CBW! Cannot deserialize");
    return {
        CBWCB: data.subarray(15, 31),
        bCBWLUN: data[13],
        bmCBWFlags: data[12],
        bCBWCBLength: data[14],
        dCBWTag: getLEUint32(data, 4),
        dDBWDataTransferLength: getLEUint32(data, 8),
    };
}


export const CDB_LEN_TABLE = [
//   0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F
     6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,  //  0
     6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,  //  1
    10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,  //  2
    10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,  //  3
    10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,  //  4
    10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,  //  5
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  //  6
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  //  7
    16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,  //  8
    16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,  //  9
    12,12,12,12,12,12,12,12,12,12,12,12,12,12,12,12,  //  A
    12,12,12,12,12,12,12,12,12,12,12,12,12,12,12,12,  //  B
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  //  C
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  //  D
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  //  E
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  //  F
];

export enum USBMassStorageSubclass{
    REDUCED_BLOCK_COMMANDS = 0x01,
    SFF8020I = 0x02,
    QIC157 = 0x03,
    UFI = 0x04,
    SFF8070I = 0x05,
    TRANSPARENT = 0x06,
}

// CDB = command descriptor block (SCSI)
export class USBMassStorageDriver{
    protected endpointIn = 0;
    protected endpointOut = 0;
    protected lun = 0;
    protected tag = 1;
    protected driverMutex = new Mutex();
    public constructor(
        protected usbDevice: USBDevice,
        protected usbSubclass: number,
    ){}

    protected async sendMassStorageOutCommand(cdb: Uint8Array, inputDataLength: number, cdbLength?: number){
        return this._sendMassStorageCommand(cdb, inputDataLength, 0x00, cdbLength);
    }
    
    protected async sendMassStorageInCommand(cdb: Uint8Array, outputDataLength: number, cdbLength?: number){
        return this._sendMassStorageCommand(cdb, outputDataLength, 0x80, cdbLength);
    }

    protected async _sendMassStorageCommand(cdb: Uint8Array, dataLength: number, direction: 0 | 0x80, cdbLength?: number){
        if(cdbLength === undefined) cdbLength = CDB_LEN_TABLE[cdb[0]];
        if(cdbLength === 0 || cdbLength > 16){
            throw new MassStorageError(`Unknown / invalid command: ${cdb[0]}`);
        }
        const release = await this.driverMutex.acquire();

        if(this.usbSubclass !== USBMassStorageSubclass.REDUCED_BLOCK_COMMANDS && this.usbSubclass !== USBMassStorageSubclass.TRANSPARENT){
            cdbLength = Math.max(12, cdbLength);
        }

        const cdbContent = new Uint8Array(16).fill(0);
        cdbContent.set(cdb.slice(0, cdbLength));
        const cbw = serializeCBW({
            bCBWLUN: this.lun,
            bmCBWFlags: direction,
            CBWCB: cdbContent,
            dCBWTag: this.tag,
            dDBWDataTransferLength: dataLength,
            bCBWCBLength: cdbLength
        });
        let retTag = this.tag++;
        let result = await this.usbDevice.transferOut(this.endpointOut, cbw);
        release();
        if(result.status !== "ok") {
            throw new MassStorageError(`Result.status != 'ok' (${result.status}) CDB 0x${cdb[0].toString(16)}`);
        }
        return {
            len: result.bytesWritten,
            expectedTag: retTag, 
        };
    }

    protected async bulkTrasferIn(length: number): Promise<{status: 'ok' | 'stall', data: Uint8Array | null}>{
        const release = await this.driverMutex.acquire();
        let result: USBInTransferResult;
        result = await this.usbDevice.transferIn(this.endpointIn, length);

        if(!result){
            throw new MassStorageError("Cannot bulk read in");
        }

        if(result.status! === "stall"){
            try{
                await this.usbDevice.clearHalt("in", this.endpointIn);
            }catch(ex){}
            release();
            return { status: 'stall', data: null };
        }
        release();

        if(result.status !== "ok"){
            throw new MassStorageError(`Bulk read in status != 'ok' (${result.status})`);
        }
        const data = new Uint8Array(result.data!.buffer);
        return { status: 'ok', data };
    }

    protected async _getStatus(expectedTag: number){
        const status = await this.getMassStorageStatus(expectedTag);
        if(status === -2){
            await this.getSense();
        }
        if(status === -1) throw new MassStorageError("Command IN fail!");
        return status;
    }

    protected async sendCommandInGetResult(cdb: Uint8Array, length: number, canStall = false, cdbLength?: number){
        let status;
        let bulkReadResult;
        do{
            const { expectedTag } = await this.sendMassStorageInCommand(cdb, length, cdbLength);
            if(length > 0){
                bulkReadResult = await this.bulkTrasferIn(length);
            }else{
                bulkReadResult = { status: 'ok', data: new Uint8Array() };
            }
            status = await this._getStatus(expectedTag);
        }while(bulkReadResult.status === 'stall' && canStall);

        if(bulkReadResult.status !== 'ok'){
            throw new MassStorageError(`Command IN fail - status != 'ok' (${bulkReadResult.status})`)
        }

        return { result: bulkReadResult.data!, status };
    }

    protected async sendCommandOutGetResult(cdb: Uint8Array, data: Uint8Array, cdbLength?: number){
        const { expectedTag } = await this.sendMassStorageOutCommand(cdb, data.length, cdbLength);
        const release = await this.driverMutex.acquire();
        const result = await this.usbDevice.transferOut(this.endpointOut, data);
        release();
        const status = await this._getStatus(expectedTag);
        return { result, status };
    }


    async getSense(){
        const result = await this.sendCommandInGetResult(new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x12]), 0x12);
        if(result.result[0] !== 0x70 && result.result[0] !== 0x71){
            throw new MassStorageError("No SENSE data!");
        }else{
            // console.log(`[MSC]: Sense: ${(result.result[2] & 0xF).toString(16)} ${result.result[12].toString(16)} ${result.result[13].toString(16)}`);
        }
        return result;
    }

    async getMassStorageStatus(expectedTag: number){
        let result;
        do{
            result = await this.bulkTrasferIn(13);
        }while(result.status === 'stall');
        const csw = deserializeCSW(result.data!);
        // In theory we also should check dCSWDataResidue.  But lots of devices
        // set it wrongly.
        if(csw.dCSWTag !== expectedTag){
            throw new MassStorageError(`Got a different tag! (${csw.dCSWTag} != ${expectedTag})`);
        }
        if(csw.bCSWStatus === 1){
            return -2; // request get sense
        }else if(csw.bCSWStatus !== 0){
            return -1;
        }else{
            return 0;
        }
    }

    async init(){
        //await this.usbDevice.reset();
        await this.usbDevice.claimInterface(0);
        for(let endpoint of this.usbDevice.configuration!.interfaces[0].alternate.endpoints){
            if(endpoint.type !== 'bulk') continue;
            if(endpoint.direction === 'in'){
                this.endpointIn = endpoint.endpointNumber;
            }else if(endpoint.direction === 'out'){
                this.endpointOut = endpoint.endpointNumber;
            }
        }
        if(!this.endpointIn || !this.endpointOut) throw new Error("Failed to find bulk I/O endpoints of device");
        this.lun = await this.getMaxLun();
    }

    async getMaxLun(){
        const release = await this.driverMutex.acquire();
        const result = await this.usbDevice.controlTransferIn({
            requestType: 'class',
            recipient: 'interface',
            index: 0,
            value: 0,
            request: 0xFE,
        }, 1);
        release();
        if(result!.status === "stall"){
            return 0;
        }else if(result!.status !== "ok"){
            throw new MassStorageError("Cannot get lun!");
        }else{
            return result.data!.getUint8(0);
        }
    }

    async inquiry(){
        const response = await this.sendCommandInGetResult(new Uint8Array([0x12, 0, 0, 0, 0x24]), 0x24, true);
        const tx = new TextDecoder();
        const t = (e: Uint8Array) => tx.decode(e);
        const vid = t(response.result.subarray(8, 16));
        const pid = t(response.result.subarray(16, 24));
        const rev = t(response.result.subarray(32, 36));
        return { vid, pid, rev };
    }

    async getCapacity(){
        const response = await this.sendCommandInGetResult(new Uint8Array([0x25]), 8, true);
        const maxLba = getBEUint32(response.result, 0);
        const blockSize = getBEUint32(response.result, 4);
        const deviceSize = (maxLba+1)*blockSize;
        
        const units = ["B", "KiB", "MiB", "GiB", "TiB"];
        let i = Math.floor(Math.log(deviceSize) / Math.log(1024));
        const humanReadable = `${Math.round(deviceSize / Math.pow(1024, i) * 100) / 100} ${units[i]}`

        return { maxLba, blockSize, deviceSize, humanReadable };
    }

    async readBlocks(address: number, count: number, blockSize?: number){
        if(blockSize === undefined){
            ({ blockSize } = await this.getCapacity());
        }
        const cdb = new Uint8Array([
            0x28, // READ(10),
            0x00,
            ...getBEUint32AsBytes(address),
            0x00,
            ...getBEUint16AsBytes(count),
        ])
        const response = await this.sendCommandInGetResult(cdb, count * blockSize, true);
        return response.result;
    }

    async writeBlocks(address: number, data: Uint8Array, blockSize?: number){
        if(blockSize === undefined){
            ({ blockSize } = await this.getCapacity());
        }
        if(data.length % blockSize !== 0){
            throw new MassStorageError("Can only write blocks of lengths multiple of the device's block size!");
        }
        const cdb = new Uint8Array([
            0x2A, // WRITE(10),
            0x00,
            ...getBEUint32AsBytes(address),
            0x00,
            ...getBEUint16AsBytes(data.length / blockSize),
        ]);
        await this.sendCommandOutGetResult(cdb, data);
    }

    async createFatFSVolumeDriverFromMBRPart(partition: number, rw = false){
        const devInfo = await this.inquiry();
        const capacity = await this.getCapacity();
        const mbr = await this.readBlocks(0, 1, capacity.blockSize);
        const partInfo = partition === null ? { sectorCount: capacity.maxLba + 1, firstLBA: 0 } : getNthPartitionFromMBR(mbr, partition);

        return this.createArbitraryFatFSVolumeDriver(partInfo, capacity.blockSize, rw);
    }

    async createNUFatFSVolumeDriverFromMBRPart(partition: number, rw = false){
        const devInfo = await this.inquiry();
        const capacity = await this.getCapacity();
        const mbr = await this.readBlocks(0, 1, capacity.blockSize);
        const partInfo = partition === null ? { sectorCount: capacity.maxLba + 1, firstLBA: 0 } : getNthPartitionFromMBR(mbr, partition);

        return this.createArbitraryNUFatFSVolumeDriver(partInfo, capacity.blockSize, rw);
    }

    async createArbitraryFatFSVolumeDriver(partInfo: { sectorCount: number, firstLBA: number }, blockSize: number, rw = false){
        const fatfsDriver: {
            sectorSize: number;
            numSectors: number;
            readSectors: (i: number, dest: Uint8Array, cb: (e: any) => void) => any,
            writeSectors: ((i: number, data: Uint8Array, cb: (e: any) => void) => any) | null,
        } = {
            sectorSize: blockSize,
            numSectors: partInfo.sectorCount,
            readSectors: async (i, dest, cb) => {
                const blocksRead = await this.readBlocks(i + partInfo.firstLBA, dest.length / blockSize, blockSize);
                dest.set(blocksRead);
                cb( null );
            },
            writeSectors: !rw ? null : async (i, data, cb) => {
                await this.writeBlocks(i + partInfo.firstLBA, data, blockSize);
                cb( null );
            },
        };

        return fatfsDriver;
    }

    async createArbitraryNUFatFSVolumeDriver(partInfo: { sectorCount: number, firstLBA: number }, blockSize: number, rw = false){
        const fatfsDriver: {
            sectorSize: number;
            numSectors: number;
            readSectors: (i: number, count: number) => Promise<Uint8Array>,
            writeSectors: ((i: number, data: Uint8Array) => Promise<void>) | null,
        } = {
            sectorSize: blockSize,
            numSectors: partInfo.sectorCount,
            readSectors: async (i, count) => {
                const blocksRead = await this.readBlocks(i + partInfo.firstLBA, count, blockSize);
                return blocksRead;
            },
            writeSectors: !rw ? null : async (i, data) => {
                await this.writeBlocks(i + partInfo.firstLBA, data, blockSize);
            },
        };

        return fatfsDriver;
    }

    async close(){
        try{
            await this.usbDevice.reset();
        }catch(ex){

        }
        await this.usbDevice.releaseInterface(0);
        await this.usbDevice.close();
    }
}
