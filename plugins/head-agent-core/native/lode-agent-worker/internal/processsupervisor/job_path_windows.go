package processsupervisor

import (
	"path/filepath"
	"syscall"
)

func jobPathSpellingMatches(clean, resolved string) bool {
	if clean == resolved {
		return true
	}
	// Node's realpath may retain 8.3 names while Go expands them. Do not
	// replace this proof with EqualFold, SameFile, or general link resolution.
	// The additional alias path must contain no reparse point at any level.
	for current := clean; ; current = filepath.Dir(current) {
		pointer, err := syscall.UTF16PtrFromString(current)
		if err != nil {
			return false
		}
		attributes, err := syscall.GetFileAttributes(pointer)
		if err != nil || attributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return false
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	pointer, err := syscall.UTF16PtrFromString(clean)
	if err != nil {
		return false
	}
	buffer := make([]uint16, 32768) // Windows extended-path UTF-16 capacity.
	n, err := syscall.GetLongPathName(pointer, &buffer[0], uint32(len(buffer)))
	return err == nil && n > 0 && n < uint32(len(buffer)) && syscall.UTF16ToString(buffer[:n]) == resolved
}
