// Package canonicaljson serializes JSON values with the same key ordering and
// string escaping used by the JavaScript control plane's canonical JSON helper.
package canonicaljson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// CompareText implements JavaScript's UTF-16 code-unit lexical ordering.
func CompareText(left, right string) int {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	limit := len(leftUnits)
	if len(rightUnits) < limit {
		limit = len(rightUnits)
	}
	for index := 0; index < limit; index++ {
		if leftUnits[index] < rightUnits[index] {
			return -1
		}
		if leftUnits[index] > rightUnits[index] {
			return 1
		}
	}
	if len(leftUnits) < len(rightUnits) {
		return -1
	}
	if len(leftUnits) > len(rightUnits) {
		return 1
	}
	return 0
}

func writeJSONString(output *bytes.Buffer, value string) {
	output.WriteByte('"')
	for len(value) > 0 {
		r, size := utf8.DecodeRuneInString(value)
		if r == utf8.RuneError && size == 1 {
			r = utf8.RuneError
		}
		value = value[size:]
		switch r {
		case '"':
			output.WriteString(`\"`)
		case '\\':
			output.WriteString(`\\`)
		case '\b':
			output.WriteString(`\b`)
		case '\f':
			output.WriteString(`\f`)
		case '\n':
			output.WriteString(`\n`)
		case '\r':
			output.WriteString(`\r`)
		case '\t':
			output.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(output, `\u%04x`, r)
			} else {
				output.WriteRune(r)
			}
		}
	}
	output.WriteByte('"')
}

func writeValue(output *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		output.WriteString("null")
	case bool:
		if typed {
			output.WriteString("true")
		} else {
			output.WriteString("false")
		}
	case string:
		writeJSONString(output, typed)
	case json.Number:
		if _, err := strconv.ParseFloat(typed.String(), 64); err != nil {
			return fmt.Errorf("invalid JSON number: %w", err)
		}
		output.WriteString(typed.String())
	case json.RawMessage:
		decoder := json.NewDecoder(bytes.NewReader(typed))
		decoder.UseNumber()
		var decoded any
		if err := decoder.Decode(&decoded); err != nil {
			return err
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return errors.New("raw JSON contains trailing data")
		}
		return writeValue(output, decoded)
	case int:
		output.WriteString(strconv.Itoa(typed))
	case int8:
		output.WriteString(strconv.FormatInt(int64(typed), 10))
	case int16:
		output.WriteString(strconv.FormatInt(int64(typed), 10))
	case int32:
		output.WriteString(strconv.FormatInt(int64(typed), 10))
	case int64:
		output.WriteString(strconv.FormatInt(typed, 10))
	case uint:
		output.WriteString(strconv.FormatUint(uint64(typed), 10))
	case uint8:
		output.WriteString(strconv.FormatUint(uint64(typed), 10))
	case uint16:
		output.WriteString(strconv.FormatUint(uint64(typed), 10))
	case uint32:
		output.WriteString(strconv.FormatUint(uint64(typed), 10))
	case uint64:
		output.WriteString(strconv.FormatUint(typed, 10))
	case []any:
		output.WriteByte('[')
		for index, child := range typed {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeValue(output, child); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(left, right int) bool { return CompareText(keys[left], keys[right]) < 0 })
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			writeJSONString(output, key)
			output.WriteByte(':')
			if err := writeValue(output, typed[key]); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	default:
		return writeReflected(output, reflect.ValueOf(value))
	}
	return nil
}

func writeReflected(output *bytes.Buffer, value reflect.Value) error {
	if !value.IsValid() {
		output.WriteString("null")
		return nil
	}
	if value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			output.WriteString("null")
			return nil
		}
		return writeValue(output, value.Elem().Interface())
	}
	switch value.Kind() {
	case reflect.Struct:
		fields := map[string]reflect.Value{}
		typeOfValue := value.Type()
		for index := 0; index < value.NumField(); index++ {
			fieldType := typeOfValue.Field(index)
			if fieldType.PkgPath != "" {
				continue
			}
			tag := fieldType.Tag.Get("json")
			parts := strings.Split(tag, ",")
			name := parts[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = fieldType.Name
			}
			omitEmpty := false
			for _, option := range parts[1:] {
				if option == "omitempty" {
					omitEmpty = true
				}
			}
			fieldValue := value.Field(index)
			if omitEmpty && fieldValue.IsZero() {
				continue
			}
			fields[name] = fieldValue
		}
		keys := make([]string, 0, len(fields))
		for key := range fields {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(left, right int) bool { return CompareText(keys[left], keys[right]) < 0 })
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			writeJSONString(output, key)
			output.WriteByte(':')
			if err := writeValue(output, fields[key].Interface()); err != nil {
				return err
			}
		}
		output.WriteByte('}')
		return nil
	case reflect.Slice, reflect.Array:
		if value.Kind() == reflect.Slice && value.IsNil() {
			output.WriteString("null")
			return nil
		}
		if value.Type().Elem().Kind() == reflect.Uint8 {
			return fmt.Errorf("unsupported byte sequence: %s", value.Type())
		}
		output.WriteByte('[')
		for index := 0; index < value.Len(); index++ {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeValue(output, value.Index(index).Interface()); err != nil {
				return err
			}
		}
		output.WriteByte(']')
		return nil
	case reflect.Map:
		if value.IsNil() {
			output.WriteString("null")
			return nil
		}
		if value.Type().Key().Kind() != reflect.String {
			return fmt.Errorf("unsupported map key type: %s", value.Type().Key())
		}
		keys := value.MapKeys()
		sort.Slice(keys, func(left, right int) bool { return CompareText(keys[left].String(), keys[right].String()) < 0 })
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			writeJSONString(output, key.String())
			output.WriteByte(':')
			if err := writeValue(output, value.MapIndex(key).Interface()); err != nil {
				return err
			}
		}
		output.WriteByte('}')
		return nil
	default:
		return fmt.Errorf("unsupported normalized JSON type: %s", value.Type())
	}
}

// Marshal normalizes structs and typed slices through encoding/json, then emits
// a canonical byte sequence compatible with JSON.stringify(canonical(value)).
func Marshal(value any) ([]byte, error) {
	var direct bytes.Buffer
	if err := writeValue(&direct, value); err == nil {
		return direct.Bytes(), nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var normalized any
	if err := decoder.Decode(&normalized); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("normalized JSON contains trailing data")
	}
	var output bytes.Buffer
	if err := writeValue(&output, normalized); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
