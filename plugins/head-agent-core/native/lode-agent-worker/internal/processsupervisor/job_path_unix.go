//go:build !windows

package processsupervisor

func jobPathSpellingMatches(clean, resolved string) bool { return clean == resolved }
