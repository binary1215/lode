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
