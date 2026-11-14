//go:build !windows

package fileeffect

func readRegularBounded(string, int64) ([]byte, error) { return nil, ErrUnsupported }

func lockedEdit(Edit, func() error, func(string)) error        { return ErrUnsupported }
func ProbeRootIdentity(string) (string, error)                 { return "", ErrUnsupported }
func ProbeAncestorIdentities(string, string) ([]string, error) { return nil, ErrUnsupported }
func holdDirectory(string) (func(), error)                     { return nil, ErrUnsupported }
