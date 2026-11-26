package processsupervisor

import (
	"syscall"
	"unsafe"
)

func isAnonymousInteractiveSocket(fd int) bool {
	// syscall.Getsockname loses socklen and renders both unnamed socketpairs
	// and an empty abstract address as "@". Check the kernel's length instead;
	// an anonymous endpoint has only sa_family_t, no sun_path bytes at all.
	for _, operation := range []uintptr{syscall.SYS_GETSOCKNAME, syscall.SYS_GETPEERNAME} {
		var address syscall.RawSockaddrAny
		length := uint32(unsafe.Sizeof(address))
		_, _, errno := syscall.Syscall(operation, uintptr(fd), uintptr(unsafe.Pointer(&address)), uintptr(unsafe.Pointer(&length)))
		if errno != 0 || address.Addr.Family != syscall.AF_UNIX || length != uint32(unsafe.Offsetof(syscall.RawSockaddrUnix{}.Path)) {
			return false
		}
	}
	return true
}
