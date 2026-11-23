package repositoryscan

import "unicode/utf8"

// Reading a function's header (source analysis 0.3.4), ported rule for rule
// from scripts/lib/world/source-analysis.mjs (skipAngles, returnTypeEnd,
// functionHeader, bindingValue). After a function's name the header is read by
// bracket partners (counting ( [ { together), so a "{" inside the parameter
// list (a default "= {}", a destructured parameter) is never taken as the
// body. Every character these rules test is ASCII, so byte offsets here and
// UTF-16 offsets there land on the same characters.

func skipBlanks(masked string, index int) int {
	for index < len(masked) && isBlank(masked[index]) {
		index++
	}
	return index
}

// skipAngles reads "<…>" starting at index (masked[index] == '<') and returns
// the index after its ">", counting nested "<>" and skipping bracketed groups
// whole; "=>" is not a closer. -1 when it does not close.
func skipAngles(masked string, brackets []int, index int) int {
	depth := 0
	for ; index < len(masked); index++ {
		switch character := masked[index]; {
		case character == '(' || character == '[' || character == '{':
			if brackets[index] < 0 {
				return -1
			}
			index = brackets[index]
		case character == '<':
			depth++
		case character == '>' && byteAt(masked, index-1) != '=':
			depth--
			if depth == 0 {
				return index + 1
			}
		case character == ';' || character == ')' || character == ']' || character == '}':
			return -1
		}
	}
	return -1
}

// Words that start a statement: met in a return type on a later line, they
// end it (a declaration without a body is followed by the next statement).
var statementWords = map[string]bool{
	"function": true, "class": true, "const": true, "let": true, "var": true, "export": true,
	"declare": true, "import": true, "interface": true, "type": true, "enum": true, "namespace": true,
	"module": true, "abstract": true, "async": true, "return": true, "if": true, "for": true, "while": true,
}

func isIdentifierStart(character byte) bool {
	return isLetter(character) || character == '_' || character == '$'
}

// returnTypeEnd reads a TypeScript return type starting at index (after ":")
// and returns the index of the body's "{", or -1 when no body follows.
// Brackets and type arguments are skipped whole; a "{" after one of
// : | & , < ( [ = or "=>" is a type literal; ";", a closing bracket, "=" not
// followed by ">" or the start of a statement on a later line end the search.
// With untilArrow the type ends at a top-level "=>", whose index is returned
// instead (an arrow's return type).
func returnTypeEnd(masked, text string, brackets []int, index int, untilArrow bool) int {
	newline := false
	for ; index < len(masked); index++ {
		character := masked[index]
		if character == '\n' {
			newline = true
		}
		if isBlank(character) {
			continue
		}
		switch {
		case character == '(' || character == '[':
			if brackets[index] < 0 {
				return -1
			}
			index = brackets[index]
		case character == '<':
			after := skipAngles(masked, brackets, index)
			if after < 0 {
				return -1
			}
			index = after - 1
		case character == '{':
			before := index - 1
			for before >= 0 && isBlank(text[before]) {
				before--
			}
			previous := byteAt(text, before)
			literal := (before >= 0 && (previous == ':' || previous == '|' || previous == '&' || previous == ',' ||
				previous == '<' || previous == '(' || previous == '[' || previous == '=')) ||
				(previous == '>' && byteAt(text, before-1) == '=')
			if !literal {
				if untilArrow {
					return -1
				}
				return index
			}
			if brackets[index] < 0 {
				return -1
			}
			index = brackets[index]
		case character == '=':
			if byteAt(masked, index+1) != '>' {
				return -1
			}
			if untilArrow {
				return index
			}
			index++
		case character == ';' || character == ')' || character == ']' || character == '}':
			return -1
		case isIdentifierStart(character):
			end := index
			for end < len(masked) && isJavaScriptWord(masked[end]) {
				end++
			}
			if newline && statementWords[masked[index:end]] {
				return -1
			}
			newline = false
			index = end - 1
		}
	}
	return -1
}

// Header statuses: a body "{" was found, no body follows (an overload or a
// declare), or the parameter list does not close (the old reading stays).
const (
	headerBody     = "body"
	headerNone     = "none"
	headerUnclosed = "unclosed"
	headerArrow    = "arrow"
)

// functionHeader reads the header after a function's name (index just after
// the name) and returns its status and, for headerBody, the body's "{".
func functionHeader(masked, text string, brackets []int, index int) (string, int) {
	index = skipBlanks(masked, index)
	if byteAt(masked, index) == '<' {
		index = skipAngles(masked, brackets, index)
		if index < 0 {
			return headerUnclosed, -1
		}
		index = skipBlanks(masked, index)
	}
	if byteAt(masked, index) != '(' || brackets[index] < 0 {
		return headerUnclosed, -1
	}
	after := skipBlanks(masked, brackets[index]+1)
	if byteAt(masked, after) == '{' {
		return headerBody, after
	}
	if byteAt(masked, after) == ':' {
		if open := returnTypeEnd(masked, text, brackets, after+1, false); open >= 0 {
			return headerBody, open
		}
	}
	return headerNone, -1
}

// The value kinds bindingValue tells apart.
const (
	valueFunction = "function"
	valueArrow    = "arrow"
	valueUnclosed = "unclosed"
	valueOther    = "other"
)

// identifierAt is the identifier starting at index, read within 64 bytes as
// the JavaScript reference reads it within 64 UTF-16 units.
func identifierAt(masked string, index int) string {
	if index >= len(masked) || !isIdentifierStart(masked[index]) {
		return ""
	}
	end := index + 1
	for end < len(masked) && end < index+64 && isJavaScriptWord(masked[end]) {
		end++
	}
	return masked[index:end]
}

// bindingValue reads the value of a binding (index just after its name):
// "[: Type] = [async] [<T>] (params) [: R] =>", "= [async] param =>" and
// "= [async] function [*] [inner] (…)". It returns the value kind; for a
// function expression the header status and body "{", for an arrow the index
// just after "=>".
func bindingValue(masked, text string, brackets []int, index int) (kind, status string, at int) {
	index = skipBlanks(masked, index)
	if byteAt(masked, index) == ':' {
		// A type annotation runs to the "=" that is not part of "=>".
	annotation:
		for index++; index < len(masked); index++ {
			switch character := masked[index]; {
			case character == '(' || character == '[' || character == '{':
				if brackets[index] < 0 {
					return valueOther, "", -1
				}
				index = brackets[index]
			case character == '<':
				after := skipAngles(masked, brackets, index)
				if after < 0 {
					return valueOther, "", -1
				}
				index = after - 1
			case character == '=' && byteAt(masked, index+1) == '>':
				index++
			case character == '=':
				break annotation
			case character == ';' || character == ')' || character == ']' || character == '}':
				return valueOther, "", -1
			}
		}
	}
	if byteAt(masked, index) != '=' || byteAt(masked, index+1) == '=' || byteAt(masked, index+1) == '>' {
		return valueOther, "", -1
	}
	index = skipBlanks(masked, index+1)
	if identifierAt(masked, index) == "async" {
		if next, _ := utf8.DecodeRuneInString(masked[min(index+5, len(masked)):]); next == '(' || next == '<' || (next != utf8.RuneError && isJavaScriptSpace(next)) {
			index = skipBlanks(masked, index+5)
		}
	}
	if identifierAt(masked, index) == "function" {
		after := skipBlanks(masked, index+8)
		if byteAt(masked, after) == '*' {
			after = skipBlanks(masked, after+1)
		}
		after += len(identifierAt(masked, after))
		headerStatus, open := functionHeader(masked, text, brackets, after)
		if headerStatus == headerUnclosed {
			return valueUnclosed, "", -1
		}
		return valueFunction, headerStatus, open
	}
	if byteAt(masked, index) == '<' {
		index = skipAngles(masked, brackets, index)
		if index < 0 {
			return valueOther, "", -1
		}
		index = skipBlanks(masked, index)
	}
	if byteAt(masked, index) == '(' {
		if brackets[index] < 0 {
			return valueUnclosed, "", -1
		}
		after := skipBlanks(masked, brackets[index]+1)
		if byteAt(masked, after) == ':' {
			after = returnTypeEnd(masked, text, brackets, after+1, true)
			if after < 0 {
				return valueOther, "", -1
			}
		}
		if byteAt(masked, after) == '=' && byteAt(masked, after+1) == '>' {
			return valueArrow, "", after + 2
		}
		return valueOther, "", -1
	}
	if parameter := identifierAt(masked, index); parameter != "" {
		after := skipBlanks(masked, index+len(parameter))
		if byteAt(masked, after) == '=' && byteAt(masked, after+1) == '>' {
			return valueArrow, "", after + 2
		}
	}
	return valueOther, "", -1
}
