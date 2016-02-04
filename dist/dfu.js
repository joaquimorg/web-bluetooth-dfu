/*
 * Protocol from:
 * http://developer.nordicsemi.com/nRF51_SDK/nRF51_SDK_v8.x.x/doc/8.1.0/s110/html/a00103.html
 */

// https://github.com/umdjs/umd
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['es6-promise', 'bleat'], factory);
    } else if (typeof exports === 'object') {
        // Node. Does not work with strict CommonJS
        module.exports = factory(Promise, require('bleat'));
    } else {
        // Browser globals with support for web workers (root is window)
        root.dfu = factory(Promise, root.navigator.bluetooth);
    }
}(this, function(Promise, bluetooth) {
    "use strict";

    var packetSize = 20;
    var notifySteps = 40;

    var serviceUUID = "00001530-1212-efde-1523-785feabcd123";
    var controlUUID = "00001531-1212-efde-1523-785feabcd123";
    var packetUUID = "00001532-1212-efde-1523-785feabcd123";
    var versionUUID = "00001534-1212-efde-1523-785feabcd123";

    var ImageType = {
        None: 0,
        SoftDevice: 1,
        Bootloader: 2,
        SoftDevice_Bootloader: 3,
        Application: 4
    };

    var littleEndian = (function() {
        var buffer = new ArrayBuffer(2);
        new DataView(buffer).setInt16(0, 256, true);
        return new Int16Array(buffer)[0] === 256;
    })();

    var controlChar = null;
    var packetChar = null;
    var versionChar = null;
    var server = null;

    // Hack to see debug info
    var resultsEl = document.getElementById("results");
    function logFn(message) {
        console.log(message);
        resultsEl.innerText += message + "\n";
    }

    function findDevice(filters) {
        return bluetooth.requestDevice({
            filters: [ filters ],
            optionalServices: [serviceUUID]
        });
    }

    function writeMode(device) {
        return new Promise(function(resolve, reject) {

            // Disconnect event currently not implemented
/*
            device.addEventListener("gattserverdisconnected", () => {
                logFn("modeData written");
                resolve();                
            });
*/
            connect(device)
            .then(() => {
                logFn("writing modeData...");
                controlChar.writeValue(new Uint8Array([1]));
                return server.disconnect();
            })
            .then(() => {
                logFn("modeData written");
                resolve(device);
            }).catch(error => {
                error = "writeMode error: " + error;
                logFn(error);
                reject(error);
            });
        });
    }

    function provision(device, arrayBuffer, imageType) {
        return new Promise(function(resolve, reject) {
            imageType = imageType || ImageType.Application;

            connect(device)
            .then(() => {
                if (versionChar) {
                    versionChar.readValue()
                    .then(data => {
                        var view = new DataView(data);
                        var major = view.getUint8(0);
                        var minor = view.getUint8(1);
                        return transfer(arrayBuffer, imageType, major, minor);
                    });
                } else {
                    // Default to version 6.0
                    return transfer(arrayBuffer, imageType, 6, 0);
                }
            })
            .then(() => {
                resolve();
            })
            .catch(error => {
                logFn(error);
                reject(error);
            });
        });
    }

    function connect(device) {
        return new Promise(function(resolve, reject) {
            var service = null;
            // Disconnect event currently not implemented
/*
            device.addEventListener("gattserverdisconnected", () => {
                logFn("device disconnected");
                service = null;
                controlChar = null;
                packetChar = null;
                versionChar = null;
                server = null;
            });
*/
            device.connectGATT()
            .then(gattServer => {
                // Connected
                server = gattServer;
                logFn("connected to device");
                return server.getPrimaryService(serviceUUID);
            })
            .then(primaryService => {
                logFn("found DFU service");
                service = primaryService;
                return service.getCharacteristic(controlUUID);
            })
            .then(characteristic => {
                logFn("found control characteristic");
                controlChar = characteristic;
                return service.getCharacteristic(packetUUID);
            })
            .then(characteristic => {
                logFn("found packet characteristic");
                packetChar = characteristic;
                service.getCharacteristic(versionUUID)
                .then(() => {
                    logFn("found version characteristic");
                    versionChar = characteristic;
                    resolve();
                })
                .catch(error => {
                    resolve();
                });
            })
            .catch(error => {
                error = "connect error: " + error;
                logFn(error);
                reject(error);
            });
        });
    };

    var interval;
    var offset;
    function transfer(arrayBuffer, imageType, majorVersion, minorVersion) {
        return new Promise(function(resolve, reject) {
            logFn('using dfu version ' + majorVersion + "." + minorVersion);

            // Set up receipts
            interval = Math.floor(arrayBuffer.byteLength / (packetSize * notifySteps));
            offset = 0;

            controlChar.addEventListener('characteristicvaluechanged', data => {
                var view = new DataView(data);
                var opCode = view.getUint8(0);

                if (opCode === 16) { // response
                    var resp_code = view.getUint8(2);
                    if (resp_code !== 1) {
                        var error = "error from control: " + resp_code;
                        logFn(error);
                        return reject(error);
                    }

                    var req_opcode = view.getUint8(1);
                    if (req_opcode === 1 && majorVersion > 6) {
                        logFn('write null init packet');

                        controlChar.writeValue(new Uint8Array([2,0]))
                        .then(() => {
                            return packetChar.writeValue(new Uint8Array([0]));
                        })
                        .then(() => {
                            return controlChar.writeValue(new Uint8Array([2,1]));
                        })
                        .catch(error => {
                            error = "error writing init: " + error;
                            logFn(error);
                            reject(error);
                        });

                    } else if (req_opcode === 1 || req_opcode === 2) {
                        logFn('complete, send packet count');

                        var buffer = new ArrayBuffer(3);
                        var view = new DataView(buffer);
                        view.setUint8(0, 8);
                        view.setUint16(1, interval, littleEndian);

                        controlChar.writeValue(view)
                        .then(() => {
                            logFn("sent packet count: " + interval);
                            return controlChar.writeValue(new Uint8Array([3]));
                        })
                        .then(() => {
                            logFn("sent receive");
                            return writePacket(arrayBuffer, 0);
                        })
                        .catch(error => {
                            error = "error sending packet count: " + error;
                            logFn(error);
                            reject(error);
                        });

                    } else if (req_opcode === 3) {
                        logFn('complete, check length');

                        controlChar.writeValue(new Uint8Array([7]))
                        .catch(error => {
                            error = "error checking length: " + error;
                            logFn(error);
                            reject(error);
                        });

                    } else if (req_opcode === 7) {
                        var bytecount = view.getUint32(3, littleEndian);
                        logFn('length: ' + bytecount);
                        logFn('complete, validate...');

                        controlChar.writeValue(new Uint8Array([4]))
                        .catch(error => {
                            error = "error validating: " + error;
                            logFn(error);
                            reject(error);
                        });

                    } else if (req_opcode === 4) {
                        logFn('complete, reset...');

                        controlChar.writeValue(new Uint8Array([5]))
                        .then(() => {
                            resolve();
                        })
                        .catch(error => {
                            error = "error resetting: " + error;
                            logFn(error);
                            reject(error);
                        });
                    }

                } else if (opCode === 17) {
                    var bytecount = view.getUint32(1, littleEndian);
                    logFn('transferred: ' + bytecount);
                    writePacket(arrayBuffer, 0);
                }
            });

            if (!controlChar.properties.notify) {
                var error = "controlChar missing notify property";
                logFn(error);
                return reject(error);
            }

            logFn("enabling notifications");
            controlChar.startNotifications()
            .then(() => {
                logFn("sending imagetype: " + imageType);
                return controlChar.writeValue(new Uint8Array([1, imageType]))
            })
            .then(() => {
                logFn("sent start");

                var softLength = (imageType === ImageType.SoftDevice) ? arrayBuffer.byteLength : 0;
                var bootLength = (imageType === ImageType.Bootloader) ? arrayBuffer.byteLength : 0;
                var appLength = (imageType === ImageType.Application) ? arrayBuffer.byteLength : 0;

                var buffer = new ArrayBuffer(12);
                var view = new DataView(buffer);
                view.setUint32(0, softLength, littleEndian);
                view.setUint32(4, bootLength, littleEndian);
                view.setUint32(8, appLength, littleEndian);

                // Set firmware length
                packetChar.writeValue(view)
                .then(() => {
                    logFn("sent buffer size: " + arrayBuffer.byteLength);            
                })
                .catch(error => {
                    error = "firmware length error: " + error;
                    logFn(error);
                    reject(error);
                });
            })
            .catch(error => {
                error = "start error: " + error;
                logFn(error);
                reject(error);
            });
        });
    }

    function writePacket(arrayBuffer, offset, count) {
        var size = (offset + packetSize > arrayBuffer.byteLength) ? arrayBuffer.byteLength - offset : packetSize;
        var packet = arrayBuffer.slice(offset, offset + size);
        var view = new Uint8Array(packet);

        packetChar.writeValue(view)
        .then(() => {
            count ++;
            offset += packetSize;
            if (count < interval && offset < arrayBuffer.byteLength) {
                writePacket(arrayBuffer, count);
            }
        })
        .catch(error => {
            error = "writePacket error: " + error;
            logFn(error);
        });
    }

    return {
        ImageType: ImageType,
        findDevice: findDevice,
        writeMode: writeMode,
        provision: provision
    };
}));