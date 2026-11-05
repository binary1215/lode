//go:build windows

package fileeffect

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func handleIdentity(h syscall.Handle) (string, error) {
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &info); err != nil {
		return "", err
	}
	if info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return "", ErrConflict
	}
	return fmt.Sprintf("windows-file-%08x-%08x%08x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}

// ProbeRootIdentity is an observation, never permission to mutate this root.
func ProbeRootIdentity(root string) (string, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return "", ErrConflict
	}
	if err := plainDirectory(root); err != nil {
		return "", err
	}
	p, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return "", err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return "", err
	}
	defer syscall.CloseHandle(h)
	return handleIdentity(h)
}

func ProbeAncestorIdentities(root, relative string) ([]string, error) {
	parts := strings.Split(relative, "/")
	// Reuse the owned-path grammar before touching any selected descendant.
	probe := Edit{Root: root, RootIdentity: "probe", Path: relative, AncestorIdentities: make([]string, len(parts))}
	for i := range probe.AncestorIdentities {
		probe.AncestorIdentities[i] = "probe"
	}
	if err := validate(probe); err != nil {
		return nil, err
	}
	var result []string
	cursor := root
	for i := range parts {
		identity, err := ProbeRootIdentity(cursor)
		if err != nil {
			return nil, err
		}
		result = append(result, identity)
		if i < len(parts)-1 {
			cursor = filepath.Join(cursor, parts[i])
		}
	}
	return result, nil
}

func holdDirectory(directory string) (func(), error) {
	var handles []syscall.Handle
	release := func() {
		for i := len(handles) - 1; i >= 0; i-- {
			syscall.CloseHandle(handles[i])
		}
	}
	for cursor := directory; ; cursor = filepath.Dir(cursor) {
		p, err := syscall.UTF16PtrFromString(cursor)
		if err != nil {
			release()
			return nil, err
		}
		h, err := syscall.CreateFile(p, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			release()
			return nil, err
		}
		handles = append(handles, h)
		if _, err := handleIdentity(h); err != nil {
			release()
			return nil, err
		}
		if filepath.Dir(cursor) == cursor {
			break
		}
	}
	return release, nil
}

func readRegularBounded(file string, limit int64) ([]byte, error) {
	release, err := holdDirectory(filepath.Dir(file))
	if err != nil {
		return nil, err
	}
	defer release()
	p, err := syscall.UTF16PtrFromString(file)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(h), file)
	defer f.Close()
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &info); err != nil {
		return nil, err
	}
	if info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks != 1 || uint64(info.FileSizeHigh)<<32|uint64(info.FileSizeLow) > uint64(limit) {
		return nil, ErrConflict
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, ErrConflict
	}
	return data, nil
}

func lockedEdit(edit Edit, beforeWrite func() error, phase func(string)) error {
	full := filepath.Join(edit.Root, filepath.FromSlash(edit.Path))
	if err := plainDirectory(filepath.Dir(full)); err != nil {
		return err
	}
	// Deny write/delete sharing on every ancestor while using pathname APIs.
	// Metadata/ACL CAS is explicitly not promised by Windows sharing semantics.
	var directories []syscall.Handle
	defer func() {
		for i := len(directories) - 1; i >= 0; i-- {
			syscall.CloseHandle(directories[i])
		}
	}()
	for cursor := filepath.Dir(full); ; cursor = filepath.Dir(cursor) {
		p, err := syscall.UTF16PtrFromString(cursor)
		if err != nil {
			return err
		}
		h, err := syscall.CreateFile(p, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return err
		}
		directories = append(directories, h)
		var info syscall.ByHandleFileInformation
		if err := syscall.GetFileInformationByHandle(h, &info); err != nil {
			return err
		}
		if info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return ErrConflict
		}
		relative, relErr := filepath.Rel(edit.Root, cursor)
		if relErr == nil && (relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
			identity, err := handleIdentity(h)
			if err != nil {
				return err
			}
			index := 0
			if relative != "." {
				index = len(strings.Split(relative, string(filepath.Separator)))
			}
			if index >= len(edit.AncestorIdentities) || identity != edit.AncestorIdentities[index] {
				return fmt.Errorf("%w: affected ancestor identity changed", ErrConflict)
			}
		}
		if filepath.Dir(cursor) == cursor {
			break
		}
	}
	p, err := syscall.UTF16PtrFromString(full)
	if err != nil {
		return err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(h), full)
	defer f.Close()
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &info); err != nil {
		return err
	}
	if info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks != 1 || uint64(info.FileSizeHigh)<<32|uint64(info.FileSizeLow) != uint64(len(edit.Before)) {
		return ErrConflict
	}
	current, err := io.ReadAll(io.LimitReader(f, int64(len(edit.Before))+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(current, edit.Before) {
		return ErrConflict
	}
	if phase != nil {
		phase("locked-preimage")
	}
	if err := beforeWrite(); err != nil {
		return err
	}
	if _, err := f.Seek(0, 0); err != nil {
		return err
	}
	if err := f.Truncate(0); err != nil {
		return err
	}
	if phase != nil {
		phase("truncated")
	}
	if _, err := f.Write(edit.After); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if phase != nil {
		phase("flushed")
	}
	if _, err := f.Seek(0, 0); err != nil {
		return err
	}
	current, err = io.ReadAll(io.LimitReader(f, int64(len(edit.After))+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(current, edit.After) {
		return fmt.Errorf("%w: postimage mismatch", ErrConflict)
	}
	return nil
}
