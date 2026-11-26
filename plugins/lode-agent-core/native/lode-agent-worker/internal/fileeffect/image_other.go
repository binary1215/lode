//go:build !windows

package fileeffect

func preflightImagePlatform(_ ImageEffect, out ImagePreflight) (ImagePreflight, error) {
	out.Reason = "platform-unsupported"
	return out, nil
}
func observeImagePlatform(ImageEffect) (Image, error) { return Image{}, ErrUnsupported }
func lockedImageEffect(ImageEffect, func() error, func(string)) (bool, error) {
	return true, ErrUnsupported
}
