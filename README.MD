## The USB Mass Storage device class driver for use with SCSI-based devices

This library lets you connect to devices such as flash drives, and interface
with them with the use of SCSI commands.

Some basic SCSI commands are already implemented, namely:

- Inquire
- Read (10)
- Write (10)
- Sense

But in general, the library is meant to be a base for projects that communicate
with devices that extend the SCSI command set with their own, propretary ones.

## Disclaimers:
- **Please do not use this if your only aim is to do something basic,
like accessing a flash drive. There are much better alternatives for that.**
- Be aware that the official WebUSB implementation denies access to devices
with interfaces defined as "Mass Storage", therefore this won't work
in the browser. It will, however, work under node, thanks to libraries
like [node-usb](https://github.com/node-usb/node-usb)

## Credits:
- [libusb's xusb example](https://github.com/libusb/libusb/tree/master/examples/xusb.c)