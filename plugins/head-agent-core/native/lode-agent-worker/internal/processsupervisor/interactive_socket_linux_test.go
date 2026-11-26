package processsupervisor

import (
	"os"
	"syscall"
	"testing"
)

func TestInteractiveRejectsEmptyAbstractSocketAddress(t *testing.T) {
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrUnix{Name: "@"}); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Listen(fd, 1); err != nil {
		t.Fatal(err)
	}
	client, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(client)
	if err := syscall.Connect(client, &syscall.SockaddrUnix{Name: "@"}); err != nil {
		t.Fatal(err)
	}
	accepted, _, err := syscall.Accept(fd)
	if err != nil {
		t.Fatal(err)
	}
	source := os.NewFile(uintptr(accepted), "synthetic-empty-abstract")
	defer source.Close()
	// Connected endpoints avoid a false pass due only to ENOTCONN. Go's
	// public string conversion makes both endpoints look like socketpair "@".
	for _, endpoint := range []int{client, accepted} {
		local, localErr := syscall.Getsockname(endpoint)
		peer, peerErr := syscall.Getpeername(endpoint)
		if localErr != nil || peerErr != nil || local.(*syscall.SockaddrUnix).Name != "@" || peer.(*syscall.SockaddrUnix).Name != "@" {
			t.Fatalf("fixture lost its ambiguous address: %v, %v, %v, %v", local, peer, localErr, peerErr)
		}
		if isAnonymousInteractiveSocket(endpoint) {
			t.Fatal("empty abstract address was confused with an unnamed socketpair")
		}
	}
	if prepared, err := prepareInteractivePipe(source); err == nil || prepared != nil {
		t.Fatalf("connected abstract address accepted: %v, %v", prepared, err)
	}
}
