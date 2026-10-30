package canonicaljson

import (
	"testing"
)

func TestMarshalMatchesJavaScriptOrderingAndEscaping(t *testing.T) {
	value := map[string]any{
		"\ue000": "private",
		"😀":      "astral",
		"text":   "<>&\u2028\u2029\n",
	}
	encoded, err := Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	expected := "{\"text\":\"<>&\u2028\u2029\\n\",\"😀\":\"astral\",\"\":\"private\"}"
	if string(encoded) != expected {
		t.Fatalf("unexpected canonical JSON:\n%s\nwant:\n%s", encoded, expected)
	}
}

func TestCompareTextUsesUTF16CodeUnits(t *testing.T) {
	if CompareText("😀", "\ue000") >= 0 {
		t.Fatal("astral character must sort before U+E000 under JavaScript UTF-16 ordering")
	}
}

func TestMarshalDirectlyCanonicalizesStructsAndTypedSlices(t *testing.T) {
	type fixture struct {
		Zulu  int      `json:"zulu"`
		Alpha []string `json:"alpha"`
		Empty []string `json:"empty"`
	}
	encoded, err := Marshal(fixture{Zulu: 2, Alpha: []string{"one"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"alpha":["one"],"empty":null,"zulu":2}` {
		t.Fatalf("unexpected direct struct encoding: %s", encoded)
	}
}
