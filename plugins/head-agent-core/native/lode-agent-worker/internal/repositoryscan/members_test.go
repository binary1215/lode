package repositoryscan

import (
	"reflect"
	"strings"
	"testing"
)

// The same rules as test/call-precision.test.mjs for the shared scan:
// members are declarations, a method definition is not a call, and an import
// list gives the same bindings whatever its layout.
func TestMembersAreDeclarationsAndNotCalls(t *testing.T) {
	text := strings.Join([]string{
		"export class Store extends Base {",
		"  #items = [];",
		"  constructor(name) {",
		"    super(name);",
		"  }",
		"  static create(name) {",
		"    return this.#decode(name);",
		"  }",
		"  get size() {",
		"    return 0;",
		"  }",
		"  #decode(raw) {",
		"    return raw;",
		"  }",
		"}",
		"export const api = {",
		"  run() {",
		"    return helper();",
		"  },",
		"  stop: () => helper(),",
		"};",
		"function helper() {",
		"  return flag ? first({ a }) : second({ b });",
		"}",
		"",
	}, "\n")
	lines := newlineOffsets(text)
	names := []string{}
	for _, value := range extractSymbols(text, "javascript", lines) {
		names = append(names, value.(map[string]any)["qualifiedName"].(string))
	}
	expected := []string{"Store", "Store.constructor", "Store.create", "Store.size", "Store.#decode", "api.run", "api.stop", "helper"}
	if !reflect.DeepEqual(names, expected) {
		t.Fatalf("unexpected declarations: %#v", names)
	}
	callees := []string{}
	for _, value := range extractCalls(text, "javascript", lines) {
		callees = append(callees, value.(map[string]any)["callee"].(string))
	}
	expectedCalls := []string{"super", "this.#decode", "helper", "helper", "first", "second"}
	if !reflect.DeepEqual(callees, expectedCalls) {
		t.Fatalf("unexpected calls: %#v", callees)
	}
}

func TestFieldsClassExpressionsAndSignatures(t *testing.T) {
	text := strings.Join([]string{
		"export class Odd {",
		"  onClick = () => this.multi(3, 4);",
		"  multi(a, b) {",
		"    return a * b;",
		"  }",
		"}",
		"export const Anonymous = class {",
		"  run() {}",
		"};",
		"export default class extends Odd {",
		"  go() {}",
		"}",
		"export abstract class Shape {",
		"  abstract render(): void;",
		"  value = compute();",
		"}",
		"",
	}, "\n")
	lines := newlineOffsets(text)
	names := []string{}
	for _, value := range extractSymbols(text, "typescript", lines) {
		names = append(names, value.(map[string]any)["qualifiedName"].(string))
	}
	expected := []string{"Odd", "Odd.onClick", "Odd.multi", "Anonymous", "Anonymous.run", "default", "default.go", "Shape"}
	if !reflect.DeepEqual(names, expected) {
		t.Fatalf("unexpected declarations: %#v", names)
	}
	callees := []string{}
	for _, value := range extractCalls(text, "typescript", lines) {
		call := value.(map[string]any)
		callees = append(callees, call["callee"].(string))
	}
	if !reflect.DeepEqual(callees, []string{"this.multi", "compute"}) {
		t.Fatalf("unexpected calls (a signature is not a call): %#v", callees)
	}
}

func TestWindowsCountUTF16UnitsLikeJavaScript(t *testing.T) {
	// The body "{" after a comment of 360 Hangul characters is within 500
	// UTF-16 units of the class line (but over 1000 bytes away).
	text := "class Late\n/* " + strings.Repeat("한", 360) + " */\n{\n  late() {}\n}\n"
	names := []string{}
	for _, value := range extractSymbols(text, "javascript", newlineOffsets(text)) {
		names = append(names, value.(map[string]any)["qualifiedName"].(string))
	}
	if !reflect.DeepEqual(names, []string{"Late", "Late.late"}) {
		t.Fatalf("unexpected declarations: %#v", names)
	}
}

func TestPythonImportLayoutsGiveTheSameBindings(t *testing.T) {
	layout := "from .models import (\n    Item,  # note\n    make as build,\n)\nfrom .other import a, \\\n    b as c\n"
	single := "from .models import Item, make as build\nfrom .other import a, b as c\n"
	if got, want := extractBindings(layout, "python"), extractBindings(single, "python"); !reflect.DeepEqual(got, want) {
		t.Fatalf("layouts differ:\n%#v\n%#v", got, want)
	}
}

func TestImportListLayoutsGiveTheSameBindings(t *testing.T) {
	layout := "import Main, {\n  first,\n  second as other, // note\n  /* block */ third,\n} from \"./m.mjs\";\nimport Whole, * as all from \"./w.mjs\";\n"
	single := "import Main, { first, second as other, third } from \"./m.mjs\";\nimport Whole, * as all from \"./w.mjs\";\n"
	if got, want := extractBindings(layout, "javascript"), extractBindings(single, "javascript"); !reflect.DeepEqual(got, want) {
		t.Fatalf("layouts differ:\n%#v\n%#v", got, want)
	}
	if count := len(extractBindings(layout, "javascript")); count != 6 {
		t.Fatalf("expected 6 bindings, got %d", count)
	}
}
