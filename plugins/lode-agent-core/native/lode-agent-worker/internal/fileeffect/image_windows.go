//go:build windows

package fileeffect

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var imageKernel = syscall.NewLazyDLL("kernel32.dll")
var setFileInformation = imageKernel.NewProc("SetFileInformationByHandle")
var volumeInformationByHandle = imageKernel.NewProc("GetVolumeInformationByHandleW")
var driveType = imageKernel.NewProc("GetDriveTypeW")

func holdImageAncestors(effect ImageEffect) (func(), syscall.Handle, error) {
	full := filepath.Join(effect.Root, filepath.FromSlash(effect.Path))
	if err := plainDirectory(filepath.Dir(full)); err != nil {
		return nil, 0, err
	}
	var handles []syscall.Handle
	release := func() {
		for i := len(handles) - 1; i >= 0; i-- {
			syscall.CloseHandle(handles[i])
		}
	}
	var rootHandle syscall.Handle
	for cursor := filepath.Dir(full); ; cursor = filepath.Dir(cursor) {
		p, err := syscall.UTF16PtrFromString(cursor)
		if err != nil {
			release()
			return nil, 0, err
		}
		h, err := syscall.CreateFile(p, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING,
			syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			release()
			return nil, 0, err
		}
		handles = append(handles, h)
		identity, err := handleIdentity(h)
		if err != nil {
			release()
			return nil, 0, err
		}
		relative, relErr := filepath.Rel(effect.Root, cursor)
		if relErr == nil && (relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
			index := 0
			if relative != "." {
				index = len(strings.Split(relative, string(filepath.Separator)))
			} else {
				rootHandle = h
			}
			if index >= len(effect.AncestorIdentities) || identity != effect.AncestorIdentities[index] {
				release()
				return nil, 0, errImageAncestor
			}
		}
		if filepath.Dir(cursor) == cursor {
			break
		}
	}
	return release, rootHandle, nil
}

func localNTFS(root string, rootHandle syscall.Handle) (bool, error) {
	volumeRoot := filepath.VolumeName(root) + string(filepath.Separator)
	p, err := syscall.UTF16PtrFromString(volumeRoot)
	if err != nil {
		return false, err
	}
	drive, _, _ := driveType.Call(uintptr(unsafe.Pointer(p)))
	if drive != 3 {
		return false, nil
	} // DRIVE_FIXED: remote/removable semantics are not claimed.
	var name [32]uint16
	ok, _, callErr := volumeInformationByHandle.Call(uintptr(rootHandle), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
	if ok == 0 {
		return false, callErr
	}
	return syscall.UTF16ToString(name[:]) == "NTFS", nil
}

func preflightImagePlatform(effect ImageEffect, out ImagePreflight) (ImagePreflight, error) {
	for _, image := range []Image{effect.Before, effect.After} {
		if image.Kind == "file" && image.Mode != 0444 && image.Mode != 0666 {
			out.Reason = "mode-not-representable"
			return out, nil
		}
	}
	if out.Operation == "edit" && effect.Before.Mode == 0444 {
		// Acquiring a data-write handle for a readonly target is denied. Clearing
		// readonly and reopening would add a release/reopen byte-race window.
		out.Reason = "readonly-byte-edit-unsupported"
		return out, nil
	}
	identities, err := ProbeAncestorIdentities(effect.Root, effect.Path)
	if errors.Is(err, os.ErrNotExist) {
		out.Reason = "missing-parent-directory"
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if effect.RootIdentity == "" && len(effect.AncestorIdentities) == 0 {
		effect.RootIdentity, effect.AncestorIdentities = identities[0], identities
	}
	release, rootHandle, err := holdImageAncestors(effect)
	if err != nil {
		return out, err
	}
	defer release()
	supported, err := localNTFS(effect.Root, rootHandle)
	if err != nil {
		return out, err
	}
	if !supported {
		out.Reason = "filesystem-not-local-ntfs"
		return out, nil
	}
	out.Status, out.Reason = "supported", "existing-parent-local-ntfs"
	out.RootIdentity, out.AncestorIdentities = effect.RootIdentity, append([]string(nil), effect.AncestorIdentities...)
	return out, nil
}

func readImageHandle(file *os.File, maxBytes int64) (Image, error) {
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &info); err != nil {
		return Image{}, err
	}
	if info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks != 1 ||
		uint64(info.FileSizeHigh)<<32|uint64(info.FileSizeLow) > uint64(maxBytes) {
		return Image{}, ErrConflict
	}
	if _, err := file.Seek(0, 0); err != nil {
		return Image{}, err
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return Image{}, err
	}
	if int64(len(data)) > maxBytes {
		return Image{}, ErrConflict
	}
	mode := uint32(0666)
	if info.FileAttributes&syscall.FILE_ATTRIBUTE_READONLY != 0 {
		mode = 0444
	}
	return Image{Kind: "file", Content: data, Mode: mode}, nil
}

func openImageTarget(effect ImageEffect, access, disposition uint32) (*os.File, error) {
	full := filepath.Join(effect.Root, filepath.FromSlash(effect.Path))
	p, err := syscall.UTF16PtrFromString(full)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, access, 0, nil, disposition, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), full), nil
}

func observeImagePlatform(effect ImageEffect) (Image, error) {
	release, _, err := holdImageAncestors(effect)
	if err != nil {
		return Image{}, err
	}
	defer release()
	file, err := openImageTarget(effect, syscall.GENERIC_READ, syscall.OPEN_EXISTING)
	if errors.Is(err, os.ErrNotExist) {
		return Image{Kind: "absent"}, nil
	}
	if err != nil {
		return Image{}, err
	}
	defer file.Close()
	return readImageHandle(file, int64(max(len(effect.Before.Content), len(effect.After.Content))))
}

func setReadonlyHandle(file *os.File, mode uint32) error {
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &info); err != nil {
		return err
	}
	attributes := info.FileAttributes &^ syscall.FILE_ATTRIBUTE_READONLY
	if mode == 0444 {
		attributes |= syscall.FILE_ATTRIBUTE_READONLY
	}
	if attributes == 0 {
		attributes = syscall.FILE_ATTRIBUTE_NORMAL
	}
	// Other attributes are preserved as observed, not claimed atomic with an
	// external attribute writer. Zero times leave existing timestamps alone.
	basic := struct {
		CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
		Attributes                                              uint32
		Padding                                                 uint32
	}{Attributes: attributes}
	ok, _, err := setFileInformation.Call(file.Fd(), 0, uintptr(unsafe.Pointer(&basic)), unsafe.Sizeof(basic))
	if ok == 0 {
		return err
	}
	return nil
}

// knownNoEffect is true only for positively observed pre-effect failure (for
// example CREATE_NEW rejected an occupied destination). Crash has no return and
// therefore cannot create this proof, even when current bytes look unchanged.
func lockedImageEffect(effect ImageEffect, beforeEffect func() error, phase func(string)) (knownNoEffect bool, err error) {
	release, rootHandle, err := holdImageAncestors(effect)
	if err != nil {
		return true, err
	}
	defer release()
	supported, err := localNTFS(effect.Root, rootHandle)
	if err != nil {
		return true, err
	}
	if !supported {
		return true, ErrUnsupported
	}
	callPhase := func(value string) {
		if phase != nil {
			phase(value)
		}
	}
	operation := imageOperation(effect)
	var file *os.File
	if operation == "create" {
		// Parent handles prevent ancestor replacement, not namespace insertion.
		// CREATE_NEW is the exclusive absence check; a losing caller never opens
		// or truncates the competing file, including a competing empty file.
		if err := beforeEffect(); err != nil {
			return true, err
		}
		callPhase("before-create")
		file, err = openImageTarget(effect, syscall.GENERIC_READ|syscall.GENERIC_WRITE|syscall.FILE_WRITE_ATTRIBUTES, syscall.CREATE_NEW)
		if err != nil {
			return true, err
		}
		defer file.Close()
		callPhase("created-empty")
	} else {
		access := uint32(syscall.GENERIC_READ | syscall.FILE_WRITE_ATTRIBUTES)
		if operation == "edit" {
			access |= syscall.GENERIC_WRITE
		}
		if operation == "delete" {
			access |= 0x00010000
		} // DELETE access for disposition by exact handle.
		file, err = openImageTarget(effect, access, syscall.OPEN_EXISTING)
		if err != nil {
			return true, err
		}
		defer file.Close()
		current, err := readImageHandle(file, int64(len(effect.Before.Content)))
		if err != nil {
			return true, err
		}
		if !sameImage(current, effect.Before) {
			return true, ErrConflict
		}
		callPhase("locked-preimage")
		if err := beforeEffect(); err != nil {
			return true, err
		}
	}
	if operation == "delete" {
		if effect.Before.Mode == 0444 {
			if err := setReadonlyHandle(file, 0666); err != nil {
				return false, err
			}
			callPhase("readonly-cleared")
		}
		remove := byte(1)
		ok, _, err := setFileInformation.Call(file.Fd(), 4, uintptr(unsafe.Pointer(&remove)), unsafe.Sizeof(remove))
		if ok == 0 {
			return false, err
		}
		callPhase("delete-marked")
		if err := file.Close(); err != nil {
			return false, err
		}
		callPhase("deleted")
		// A replacement appearing after close is never deleted automatically.
		full := filepath.Join(effect.Root, filepath.FromSlash(effect.Path))
		if _, err := os.Lstat(full); !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return false, err
			}
			return false, ErrConflict
		}
		return false, nil
	}
	if operation == "edit" {
		if _, err := file.Seek(0, 0); err != nil {
			return false, err
		}
		if err := file.Truncate(0); err != nil {
			return false, err
		}
		callPhase("truncated")
	}
	if operation == "edit" || operation == "create" {
		if n, err := file.Write(effect.After.Content); err != nil {
			return false, err
		} else if n != len(effect.After.Content) {
			return false, io.ErrShortWrite
		}
		if err := file.Sync(); err != nil {
			return false, err
		}
		callPhase("flushed")
	}
	if operation == "create" || effect.Before.Mode != effect.After.Mode {
		if err := setReadonlyHandle(file, effect.After.Mode); err != nil {
			return false, err
		}
		callPhase("mode-updated")
	}
	current, err := readImageHandle(file, int64(len(effect.After.Content)))
	if err != nil {
		return false, err
	}
	if !sameImage(current, effect.After) {
		return false, ErrConflict
	}
	return false, nil
}
