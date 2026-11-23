package repositoryscan

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

// Source analysis 0.3.4: a function's body is found after its parameter list
// closes (a "{" in a default or a destructured parameter is not the body),
// TypeScript return types are read past type literals, a declaration without
// a body is one statement, and a type ends at a top-level "," or at a line
// break not after a type operator (type-ends: ternaries, annotations).
// The expected values are the JavaScript reference's output on the same
// corpus files (ranges, signatures, scope paths and the caller of each call).
func TestFunctionRangesMatchTheJavaScriptReference(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve repository scan test source")
	}
	fixtures := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "..", "benchmarks", "repository-scan-v1", "basic", "fixtures"))
	cases := []struct {
		file, language string
		symbols, calls []string
	}{
		{
			file: "function-ranges.mjs", language: "javascript",
			symbols: []string{
				"function withDefaults 5-7 scope= [function withDefaults(a, options = {})]",
				"function destructured 9-11 scope= [function destructured({ a, b })]",
				"function bothDefaults 13-15 scope= [function bothDefaults({ a } = {}, [b] = [])]",
				"function multiLine 17-22 scope= [function multiLine( a, { b } = {}, )]",
				"function generated 24-26 scope= [async function* generated({ a } = {})]",
				"function exported 28-30 scope= [function exported(options = {})]",
				"binding expression 32-34 scope= [const expression = function ({ a })]",
				"function named.inner 36-38 scope=named [async function inner(a = {})]",
				"binding named 36-38 scope= [const named = async function inner(a = {})]",
				"binding defaultCall 40-42 scope= [const defaultCall = (a = first()) =>]",
				"binding single 44-44 scope= [const single = (x) => first(x);]",
				"binding invoked 46-49 scope= [const invoked = (() =>]",
				"function invoked.hidden 47-47 scope=invoked [function hidden()]",
				"function outer 51-56 scope= [function outer(options = {})]",
				"function outer.nested 52-54 scope=outer [function nested()]",
			},
			calls: []string{
				"first@6<-withDefaults",
				"first@10<-destructured",
				"first@14<-bothDefaults",
				"first@21<-multiLine",
				"first@25<-generated",
				"first@29<-exported",
				"first@33<-expression",
				"first@37<-named.inner",
				"first@40<-defaultCall",
				"first@41<-defaultCall",
				"first@44<-single",
				"first@53<-outer.nested",
				"nested@55<-outer",
			},
		},
		{
			file: "function-ranges.ts", language: "typescript",
			symbols: []string{
				"function generic 11-13 scope= [function generic<T extends { a: string }>(x: T): Promise<{ a: string }>]",
				"function literalReturn 15-17 scope= [function literalReturn(): { a: string }]",
				"function isFoo 19-21 scope= [function isFoo(x: unknown): x is Foo]",
				"function overloaded 23-23 scope= [function overloaded(a: string): { a: string };]",
				"function overloaded 24-24 scope= [function overloaded(a: number): void;]",
				"function overloaded 25-27 scope= [function overloaded(a: any)]",
				"function declared 29-29 scope= [function declared(): void]",
				"function afterDeclare 30-32 scope= [function afterDeclare(options = {})]",
				"class Loader 34-41 scope= [class Loader]",
				"function Loader.load 35-37 scope=Loader [load(): Promise<{ a: string }>]",
				"function Loader.value 38-40 scope=Loader [get value(): { a: string }]",
				"binding callbackType 43-45 scope= [const callbackType = (cb: () => void) =>]",
				"binding returnType 47-49 scope= [const returnType = async (a): Promise<void> =>]",
				"binding annotated 51-53 scope= [const annotated: Handler = (a) =>]",
				"binding identity 55-55 scope= [const identity = <T,>(a: T) => a;]",
			},
			calls: []string{
				"first@12<-generic",
				"first@16<-literalReturn",
				"first@20<-isFoo",
				"first@26<-overloaded",
				"first@31<-afterDeclare",
				"first@36<-Loader.load",
				"first@39<-Loader.value",
				"first@44<-callbackType",
				"async@47<-returnType",
				"first@48<-returnType",
				"first@52<-annotated",
			},
		},
		{
			file: "type-ends.mjs", language: "javascript",
			symbols: []string{
				"function api.run 11-13 scope=api [run()]",
				"class Holder 16-21 scope= [export class Holder]",
				"function Holder.run 18-20 scope=Holder [run()]",
				"function table.go 26-28 scope=table [go()]",
				"function host 31-35 scope= [export function host(register)]",
				"function guarded 37-44 scope= [export function guarded()]",
			},
			calls: []string{
				"first@10<-",
				"first@12<-api.run",
				"first@17<-",
				"first@19<-Holder.run",
				"first@24<-",
				"first@27<-table.go",
				"first@32<-host",
				"register@32<-host",
				"first@33<-host",
				"first@38<-guarded",
				"first@40<-guarded",
				"first@42<-guarded",
			},
		},
		{
			file: "type-ends.ts", language: "typescript",
			symbols: []string{
				"function thing.handler 8-8 scope=thing [handler: (a: unknown) => a]",
				"binding load 11-13 scope= [const load = async (id: string) =>]",
				"binding typed 24-26 scope= [const typed: (a: number) => void = (a) =>]",
				"function pick 28-30 scope= [function pick<T>(x: T): T extends string ? { s: string } : { n: number }]",
				"function union 32-35 scope= [function union(): Foo | null]",
				"function leading 37-41 scope= [function leading(): | { a: string } | null]",
				"function check 43-46 scope= [function check(x: unknown): asserts x is Foo]",
			},
			calls: []string{
				"async@11<-load",
				"first@12<-load",
				"first@17<-",
				"first@21<-",
				"first@25<-typed",
				"first@29<-pick",
				"first@34<-union",
				"first@40<-leading",
				"first@45<-check",
			},
		},
	}
	for _, item := range cases {
		raw, err := os.ReadFile(filepath.Join(fixtures, item.file))
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		lines := newlineOffsets(text)
		symbols := []string{}
		for _, value := range extractSymbols(text, item.language, lines) {
			symbol := value.(map[string]any)
			symbols = append(symbols, fmt.Sprintf("%s %s %d-%d scope=%s [%s]", symbol["kind"], symbol["qualifiedName"], symbol["line"], symbol["endLine"], symbol["scopePath"], symbol["signature"]))
		}
		if !reflect.DeepEqual(symbols, item.symbols) {
			t.Fatalf("%s: unexpected declarations: %#v", item.file, symbols)
		}
		calls := []string{}
		for _, value := range extractCalls(text, item.language, lines) {
			call := value.(map[string]any)
			caller, _ := call["callerQualifiedName"].(string)
			calls = append(calls, fmt.Sprintf("%s@%d<-%s", call["callee"], call["line"], caller))
		}
		if !reflect.DeepEqual(calls, item.calls) {
			t.Fatalf("%s: unexpected calls: %#v", item.file, calls)
		}
	}
}
