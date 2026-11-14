//go:build !linux && !windows

package processsupervisor

import "syscall"

func isAnonymousInteractiveSocket(fd int) bool {
	local, localErr := syscall.Getsockname(fd)
	peer, peerErr := syscall.Getpeername(fd)
	localUnix, localOK := local.(*syscall.SockaddrUnix)
	peerUnix, peerOK := peer.(*syscall.SockaddrUnix)
	return localErr == nil && peerErr == nil && localOK && peerOK && localUnix.Name == "" && peerUnix.Name == ""
}
