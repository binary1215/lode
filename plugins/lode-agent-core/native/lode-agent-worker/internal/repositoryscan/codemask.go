package repositoryscan

import (
	"strings"
	"unicode/utf8"
)

// The JavaScript / TypeScript lexer of scripts/lib/world/source-code-mask.mjs
// (codeMask with kind "javascript"), ported rule for rule so the Go and
// JavaScript scans read the same characters as code.
//
// Offsets: the JavaScript lexer walks UTF-16 code units and this one walks
// UTF-8 bytes. Every character the lexer reacts to (quotes, slashes, braces,
// "$", "\\", "\n", operators and keyword letters) is ASCII, so it is one unit
// in both encodings and each decision is taken at the same character. The
// lexer only marks ranges that start and end at such characters, so a
// non-ASCII character is always marked as a whole (all of its bytes here, all
// of its code units there). Where JavaScript tests a character with /\s/,
// which includes Unicode spaces, isJavaScriptSpace decodes the rune. An escape
// skips one byte here and one code unit there; the bytes or units skipped into
// are never ASCII, so the walk meets the next ASCII character in both.
// Line breaks are "\n" in both (a "\r" before it is an ordinary character).

const (
	maskText         byte = 0
	maskCode         byte = 1
	maskTemplateOpen byte = 2 // the "$" and "{" that open a template's ${...}; code
)

const regexAllowedAfter = "(,=:[!&|?{};+-*%<>~^"

// Keywords after which "/" starts a regular expression, not a division.
var regexKeywords = map[string]bool{
	"return": true, "typeof": true, "case": true, "in": true, "of": true, "delete": true, "void": true,
	"throw": true, "new": true, "else": true, "do": true, "yield": true, "await": true,
}

// The characters JavaScript's /\s/ matches.
func isJavaScriptSpace(r rune) bool {
	switch {
	case r >= 0x09 && r <= 0x0D, r == 0x20, r == 0xA0, r == 0x1680, r >= 0x2000 && r <= 0x200A,
		r == 0x2028, r == 0x2029, r == 0x202F, r == 0x205F, r == 0x3000, r == 0xFEFF:
		return true
	}
	return false
}

func isJavaScriptWord(b byte) bool {
	return b == '_' || b == '$' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// previousStart marks "no character yet"; previousOther a non-ASCII character
// that is not a space (it is in no ASCII set the lexer tests).
const (
	previousStart = -1
	previousOther = 0x80
)

// javascriptCodeMask returns one entry per byte (maskText, maskCode or
// maskTemplateOpen) and whether the reading can be trusted: false when the
// text ends inside a template, block comment or ${...}.
func javascriptCodeMask(text string) ([]byte, bool) {
	length := len(text)
	mask := make([]byte, length)
	for index := range mask {
		mask[index] = maskCode
	}
	trusted := true
	blank := func(from, to int) {
		if to > length {
			to = length
		}
		for index := from; index < to; index++ {
			mask[index] = maskText
		}
	}
	at := func(index int) byte {
		if index < 0 || index >= length {
			return 0
		}
		return text[index]
	}
	keywordBefore := func(index int) bool {
		end := index
		for end > 0 {
			r, size := utf8.DecodeLastRuneInString(text[:end])
			if !isJavaScriptSpace(r) {
				break
			}
			end -= size
		}
		start := end
		for start > 0 && isJavaScriptWord(text[start-1]) {
			start--
		}
		if start == end || (start > 0 && text[start-1] == '.') {
			return false
		}
		return regexKeywords[text[start:end]]
	}
	// Open braces inside each enclosing template expression.
	expressions := []int{}
	previous := previousStart
	for index := 0; index < length; index++ {
		character := text[index]
		if character >= utf8.RuneSelf {
			if utf8.RuneStart(character) {
				if r, _ := utf8.DecodeRuneInString(text[index:]); !isJavaScriptSpace(r) {
					previous = previousOther
				}
			}
			continue
		}
		if character == '/' && at(index+1) == '/' {
			end := strings.IndexByte(text[index:], '\n')
			if end < 0 {
				blank(index, length)
				index = length
			} else {
				end += index
				blank(index, end)
				index = end - 1
			}
			continue
		}
		if character == '/' && at(index+1) == '*' {
			end := strings.Index(text[index+2:], "*/")
			if end < 0 {
				trusted = false
				blank(index, length)
				index = length
			} else {
				end += index + 2
				blank(index, end+2)
				index = end + 1
			}
			continue
		}
		if character == '"' || character == '\'' {
			end := index + 1
			for end < length && text[end] != character && text[end] != '\n' {
				if text[end] == '\\' {
					end += 2
				} else {
					end++
				}
			}
			if end >= length {
				trusted = false
			}
			blank(index, end+1)
			index = end
			previous = int(character)
			continue
		}
		if character == '/' && (previous == previousStart || (previous < utf8.RuneSelf && strings.IndexByte(regexAllowedAfter, byte(previous)) >= 0) || keywordBefore(index)) {
			end := index + 1
			inClass := false
			for end < length && text[end] != '\n' && (inClass || text[end] != '/') {
				if text[end] == '\\' {
					end++
				} else if text[end] == '[' {
					inClass = true
				} else if text[end] == ']' {
					inClass = false
				}
				end++
			}
			blank(index, end+1)
			index = end
			previous = '/'
			continue
		}
		if character == '`' || (character == '}' && len(expressions) > 0 && expressions[len(expressions)-1] == 0) {
			// Template text runs to the closing backtick or the next ${.
			if character == '}' {
				expressions = expressions[:len(expressions)-1]
			}
			end := index + 1
			for end < length && text[end] != '`' && !(text[end] == '$' && at(end+1) == '{') {
				if text[end] == '\\' {
					end += 2
				} else {
					end++
				}
			}
			if end >= length {
				trusted = false
			}
			if at(end) == '`' {
				blank(index, end+1)
			} else {
				blank(index, end)
			}
			if at(end) == '$' {
				mask[end] = maskTemplateOpen
				mask[end+1] = maskTemplateOpen
				expressions = append(expressions, 0)
				index = end + 1
			} else {
				index = end
			}
			previous = '`'
			continue
		}
		if character == '{' && len(expressions) > 0 {
			expressions[len(expressions)-1]++
		} else if character == '}' && len(expressions) > 0 {
			expressions[len(expressions)-1]--
		}
		if !isJavaScriptSpace(rune(character)) {
			previous = int(character)
		}
	}
	if len(expressions) > 0 {
		trusted = false
	}
	return mask, trusted
}

// maskNonCode turns comments and string contents into spaces, keeping every
// line break and byte offset. JavaScript and TypeScript are read with the
// lexer above; a template's ${ and its closing } are masked too, so braces in
// the masked text stay balanced, and the expression inside is code. When the
// lexer cannot trust its reading, a byte counts as code if either the lexer or
// the plain quote scan says so. Python keeps the plain quote scan.
func maskNonCode(text, language string) string {
	if language != "javascript" && language != "typescript" {
		return quoteScanMask(text, language)
	}
	mask, trusted := javascriptCodeMask(text)
	fallback := ""
	if !trusted {
		fallback = quoteScanMask(text, language)
	}
	output := []byte(text)
	for index, character := range output {
		if character == '\n' || character == '\r' {
			continue
		}
		code := mask[index] == maskCode || (!trusted && fallback[index] != ' ')
		if !code {
			output[index] = ' '
		}
	}
	return string(output)
}
