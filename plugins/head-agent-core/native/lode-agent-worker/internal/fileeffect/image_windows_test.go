//go:build windows

package fileeffect

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func imageFixture(t *testing.T) (ImageEffect, string) {
	edit, journal := fixture(t)
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(edit.Root, edit.Path), 0600) })
	return ImageEffect{Root: edit.Root, RootIdentity: edit.RootIdentity, AncestorIdentities: edit.AncestorIdentities,
		Path: edit.Path, Before: Image{Kind: "file", Content: edit.Before, Mode: 0666}, After: Image{Kind: "file", Content: edit.After, Mode: 0666}, MaxBytes: edit.MaxBytes}, journal
}

func TestImageTransportLifecycleAndMode(t *testing.T) {
	effect, journal := imageFixture(t)
	if err := os.Remove(filepath.Join(effect.Root, effect.Path)); err != nil {
		t.Fatal(err)
	}
	effect.Before = Image{Kind: "absent"}
	effect.After = Image{Kind: "file", Content: []byte{}, Mode: 0666}
	initial := effect
	initial.RootIdentity, initial.AncestorIdentities = "", []string{}
	code, response, _ := callTransport(t, transportFrame(t, "image-preflight", imagePayload{initial, journal}))
	if code != 0 {
		t.Fatalf("preflight: %+v", response)
	}
	b, _ := json.Marshal(response.Result)
	var preflight ImagePreflight
	if err := json.Unmarshal(b, &preflight); err != nil || preflight.Status != "supported" || preflight.RootIdentity != effect.RootIdentity || !equalStrings(preflight.AncestorIdentities, effect.AncestorIdentities) {
		t.Fatalf("preflight: %+v %v", preflight, err)
	}
	if len(snapshotFiles(t, journal)) != 0 {
		t.Fatal("preflight wrote journal")
	}
	for _, stage := range []string{"create", "edit", "mode-readonly", "mode-writable", "delete"} {
		t.Run(stage, func(t *testing.T) {
			if stage == "edit" {
				effect.Before = effect.After
				effect.After = Image{Kind: "file", Content: []byte("updated"), Mode: 0666}
			}
			if stage == "mode-readonly" {
				effect.Before = effect.After
				effect.After.Mode = 0444
			}
			if stage == "mode-writable" {
				effect.Before = effect.After
				effect.After.Mode = 0666
			}
			if stage == "delete" {
				effect.Before = effect.After
				effect.After = Image{Kind: "absent"}
			}
			frame := transportFrame(t, "image-apply", imagePayload{effect, journal})
			code, response, _ := callTransport(t, frame)
			if code != 0 || response.Status != "ok" {
				t.Fatalf("%s apply: %d %+v", stage, code, response)
			}
			b, _ := json.Marshal(response.Result)
			var out ImageOutcome
			if err := json.Unmarshal(b, &out); err != nil || out.Status != "effect-observed" || out.CurrentImageDigest != imageDigest(effect.After) || out.MetadataCAS || out.MultiFileAtomic {
				t.Fatalf("outcome: %+v %v", out, err)
			}
			if out.DataFlushed != (stage == "create" || stage == "edit") {
				t.Fatalf("flush claim for %s: %+v", stage, out)
			}
			beforeJournal, _ := json.Marshal(snapshotFiles(t, journal))
			code, response, _ = callTransport(t, transportFrame(t, "image-inspect", imagePayload{effect, journal}))
			if code != 0 {
				t.Fatalf("inspect %s: %+v", stage, response)
			}
			b, _ = json.Marshal(response.Result)
			var inspection ImageInspection
			if err := json.Unmarshal(b, &inspection); err != nil || !inspection.CompletionRecorded || inspection.Status != "postimage-observed" || inspection.AppliedByThisRead || inspection.RetryBasisAvailable {
				t.Fatalf("inspect: %+v %v", inspection, err)
			}
			afterJournal, _ := json.Marshal(snapshotFiles(t, journal))
			if !bytes.Equal(beforeJournal, afterJournal) {
				t.Fatal("inspection changed journal")
			}
			code, response, _ = callTransport(t, frame)
			if code != 2 || response.Error.Code != "FILE_EFFECT_ALREADY_EXISTS" {
				t.Fatalf("replay accepted: %+v", response)
			}
		})
	}
	if _, err := os.Stat(filepath.Join(effect.Root, effect.Path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("delete retained file: %v", err)
	}
}

func TestImagePreflightUnsupportedHasNoEffects(t *testing.T) {
	effect, journal := imageFixture(t)
	for _, kind := range []string{"parent", "mode", "readonly-edit"} {
		candidate := effect
		want := ""
		switch kind {
		case "parent":
			candidate.Path = "missing/new.txt"
			candidate.RootIdentity = ""
			candidate.AncestorIdentities = []string{}
			candidate.Before = Image{Kind: "absent"}
			want = "missing-parent-directory"
		case "mode":
			candidate.After.Mode = 0644
			want = "mode-not-representable"
		case "readonly-edit":
			candidate.Before.Mode = 0444
			want = "readonly-byte-edit-unsupported"
		}
		out, err := PreflightImageEffect(candidate, journal)
		if err != nil || out.Status != "unsupported" || out.Reason != want {
			t.Fatalf("%s: %+v %v", kind, out, err)
		}
		if len(snapshotFiles(t, journal)) != 0 {
			t.Fatal("unsupported created journal")
		}
		if _, err := os.Stat(filepath.Join(effect.Root, "missing")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("preflight made parent")
		}
	}
}

func TestImageAbsentAndEmptyFileAreNotEquivalent(t *testing.T) {
	effect, journal := imageFixture(t)
	effect.Before = Image{Kind: "absent"}
	effect.After = Image{Kind: "file", Content: []byte{}, Mode: 0666}
	file := filepath.Join(effect.Root, effect.Path)
	if err := os.WriteFile(file, []byte{}, 0600); err != nil {
		t.Fatal(err)
	}
	out, err := ApplyImageEffect(effect, journal, nil)
	if !errors.Is(err, os.ErrExist) || out.Status != "not-started" {
		t.Fatalf("occupied empty target: %+v %v", out, err)
	}
	inspection, err := InspectImageEffect(effect, journal)
	if err != nil || !inspection.NoWriteRecorded || inspection.CompletionRecorded || inspection.Status != "postimage-observed" || inspection.RetryBasisAvailable {
		t.Fatalf("empty file inferred create: %+v %v", inspection, err)
	}
	if _, err := RetryKnownNoImageEffect(effect, journal, nil); !errors.Is(err, ErrConflict) {
		t.Fatal("occupied destination replay accepted")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	retried, err := RetryKnownNoImageEffect(effect, journal, nil)
	if err != nil || retried.Status != "effect-observed" || retried.IntentID == out.IntentID {
		t.Fatalf("known-no-effect retry: %+v %v", retried, err)
	}
	deletion := effect
	deletion.Before = deletion.After
	deletion.After = Image{Kind: "absent"}
	if _, err := ApplyImageEffect(deletion, journal, nil); err != nil {
		t.Fatal(err)
	}
	if imageDigest(Image{Kind: "absent"}) == imageDigest(Image{Kind: "file", Content: []byte{}, Mode: 0666}) {
		t.Fatal("image identities collapsed")
	}
}

func TestImagePreimageModeAndAncestorConflict(t *testing.T) {
	effect, journal := imageFixture(t)
	if err := os.Chmod(filepath.Join(effect.Root, effect.Path), 0444); err != nil {
		t.Fatal(err)
	}
	effect.After = Image{Kind: "absent"}
	out, err := ApplyImageEffect(effect, journal, nil)
	if !errors.Is(err, ErrConflict) || out.Status != "not-started" {
		t.Fatalf("mode mismatch: %+v %v", out, err)
	}
	if _, err := os.Stat(filepath.Join(effect.Root, effect.Path)); err != nil {
		t.Fatal("mismatched delete removed file")
	}
	effect.Before.Mode = 0444
	if out, err := ApplyImageEffect(effect, journal, nil); err != nil || out.Status != "effect-observed" {
		t.Fatalf("readonly delete: %+v %v", out, err)
	}
	other, journal2 := imageFixture(t)
	other.Before = Image{Kind: "absent"}
	other.Path = "nested/new.txt"
	nested := filepath.Join(other.Root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	other.AncestorIdentities, err = ProbeAncestorIdentities(other.Root, other.Path)
	if err != nil {
		t.Fatal(err)
	}
	out, err = ApplyImageEffect(other, journal2, func(stage string) {
		if stage != "intent-durable" {
			return
		}
		if err := os.Rename(nested, nested+"-old"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(nested, 0700); err != nil {
			t.Fatal(err)
		}
	})
	if !errors.Is(err, errImageAncestor) || out.Status != "not-started" {
		t.Fatalf("ancestor replacement accepted: %+v %v", out, err)
	}
	if _, err := os.Stat(filepath.Join(other.Root, other.Path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("replacement mutated")
	}
}

func imageCommand(ctx context.Context, mode string, extra ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestImageEffectSubprocess$")
	cmd.Env = append(os.Environ(), append([]string{"HEAD_IMAGE_EFFECT_TEST_MODE=" + mode}, extra...)...)
	cwd, _ := os.Getwd()
	line, _ := json.Marshal(map[string]any{"event": "planned-image-effect-test", "command": cmd.Path, "args": cmd.Args, "cwd": cwd, "parentPid": os.Getpid(), "ports": []int{}})
	fmt.Println(string(line))
	return cmd
}

func TestImageEffectSubprocess(t *testing.T) {
	mode := os.Getenv("HEAD_IMAGE_EFFECT_TEST_MODE")
	if mode == "" {
		return
	}
	if mode == "occupy" {
		f, err := os.OpenFile(os.Getenv("HEAD_IMAGE_EFFECT_TARGET"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			os.Exit(21)
		}
		if _, err := f.Write([]byte("competing owner")); err != nil {
			os.Exit(22)
		}
		f.Close()
		os.Exit(0)
	}
	if mode == "owner" {
		var effect ImageEffect
		if json.Unmarshal([]byte(os.Getenv("HEAD_IMAGE_EFFECT_INPUT")), &effect) != nil {
			os.Exit(23)
		}
		_, err := ApplyImageEffect(effect, os.Getenv("HEAD_IMAGE_EFFECT_JOURNAL"), func(stage string) {
			if stage == os.Getenv("HEAD_IMAGE_EFFECT_PHASE") {
				fmt.Println("phase:" + stage)
				select {}
			}
		})
		fmt.Fprintln(os.Stderr, err)
		os.Exit(24)
	}
	os.Exit(25)
}

func TestImageCreationRaceDoesNotOverwrite(t *testing.T) {
	effect, journal := imageFixture(t)
	effect.Before = Image{Kind: "absent"}
	effect.Path = "raced.txt"
	out, err := ApplyImageEffect(effect, journal, func(stage string) {
		if stage != "before-create" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := imageCommand(ctx, "occupy", "HEAD_IMAGE_EFFECT_TARGET="+filepath.Join(effect.Root, effect.Path))
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		fmt.Printf("{\"event\":\"started-image-effect-test\",\"pid\":%d,\"parentPid\":%d,\"ports\":[]}\n", cmd.Process.Pid, os.Getpid())
		err := cmd.Wait()
		fmt.Printf("{\"event\":\"exited-image-effect-test\",\"pid\":%d,\"ports\":[]}\n", cmd.Process.Pid)
		if err != nil {
			t.Fatal(err)
		}
	})
	if !errors.Is(err, os.ErrExist) || out.Status != "not-started" {
		t.Fatalf("create race: %+v %v", out, err)
	}
	current, _ := os.ReadFile(filepath.Join(effect.Root, effect.Path))
	if string(current) != "competing owner" {
		t.Fatal("competitor overwritten")
	}
}

func TestImageModeAndDeleteHoldExclusiveTarget(t *testing.T) {
	for _, operation := range []string{"mode", "delete"} {
		t.Run(operation, func(t *testing.T) {
			effect, journal := imageFixture(t)
			if operation == "mode" {
				effect.After = effect.Before
				effect.After.Mode = 0444
			} else {
				effect.After = Image{Kind: "absent"}
			}
			_, err := ApplyImageEffect(effect, journal, func(stage string) {
				if stage != "locked-preimage" {
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				cmd := ownedCommand(ctx, "writer", "HEAD_FILE_EFFECT_TARGET="+filepath.Join(effect.Root, effect.Path))
				if err := cmd.Start(); err != nil {
					t.Fatal(err)
				}
				fmt.Printf("{\"event\":\"started-image-effect-writer\",\"pid\":%d,\"parentPid\":%d,\"ports\":[]}\n", cmd.Process.Pid, os.Getpid())
				err := cmd.Wait()
				fmt.Printf("{\"event\":\"exited-image-effect-writer\",\"pid\":%d,\"ports\":[]}\n", cmd.Process.Pid)
				if err != nil {
					t.Fatal(err)
				}
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestImageConcurrentKnownNoEffectRetryAndABA(t *testing.T) {
	effect, journal := imageFixture(t)
	effect.Before = Image{Kind: "absent"}
	if _, err := ApplyImageEffect(effect, journal, nil); !errors.Is(err, os.ErrExist) {
		t.Fatalf("missing occupied precondition: %v", err)
	}
	file := filepath.Join(effect.Root, effect.Path)
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		group.Add(1)
		go func() { defer group.Done(); _, err := RetryKnownNoImageEffect(effect, journal, nil); results <- err }()
	}
	group.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent retries succeeded %d times", successes)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if _, err := RetryKnownNoImageEffect(effect, journal, nil); !errors.Is(err, os.ErrExist) {
		t.Fatalf("ABA allowed duplicate effect: %v", err)
	}
	if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("ABA source recreated")
	}
}

func knownNoImageCreateFixture(t *testing.T) (ImageEffect, string, string) {
	t.Helper()
	effect, journal := imageFixture(t)
	effect.Before = Image{Kind: "absent"}
	effect.Path = "nested/new.txt"
	nested := filepath.Join(effect.Root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(effect.Root, filepath.FromSlash(effect.Path))
	if err := os.WriteFile(file, []byte("occupied"), 0600); err != nil {
		t.Fatal(err)
	}
	var err error
	effect.AncestorIdentities, err = ProbeAncestorIdentities(effect.Root, effect.Path)
	if err != nil {
		t.Fatal(err)
	}
	out, err := ApplyImageEffect(effect, journal, nil)
	if !errors.Is(err, os.ErrExist) || out.Status != "not-started" {
		t.Fatalf("expected known no-effect: %+v %v", out, err)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	return effect, journal, out.IntentID
}

func replaceImageParent(t *testing.T, effect ImageEffect) func() {
	t.Helper()
	directory := filepath.Dir(filepath.Join(effect.Root, filepath.FromSlash(effect.Path)))
	retained := directory + "-retained"
	if err := os.Rename(directory, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	return func() {
		// The replacement is an exact fixture-owned empty directory. Never
		// recursively delete a computed source tree to restore the test.
		if err := os.Remove(directory); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(retained, directory); err != nil {
			t.Fatal(err)
		}
	}
}

func TestImageRetryPrepublicationFailureKeepsVerifiedPredecessor(t *testing.T) {
	effect, journal, priorID := knownNoImageCreateFixture(t)
	var restore func()
	out, err := RetryKnownNoImageEffect(effect, journal, func(stage string) {
		if stage == "retry-basis-verified" {
			restore = replaceImageParent(t, effect)
		}
	})
	if !errors.Is(err, errImageAncestor) || out.Status != "not-started" || out.IntentID != priorID {
		t.Fatalf("invented child on prepublication failure: %+v %v", out, err)
	}
	next := effect
	next.PreviousIntentID = priorID
	childID := imageInitialOutcome(next).IntentID
	if _, err := os.Stat(filepath.Join(journal, childID+".intent.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed preflight published child intent")
	}
	restore()
	inspection, err := InspectImageEffect(effect, journal)
	if err != nil || !inspection.RetryBasisAvailable {
		t.Fatalf("lost retry anchor: %+v %v", inspection, err)
	}
	out, err = RetryKnownNoImageEffect(effect, journal, nil)
	if err != nil || out.Status != "effect-observed" || out.IntentID != childID {
		t.Fatalf("valid retry remained blocked: %+v %v", out, err)
	}
}

func TestImageRetryDoesNotHideExistingOrPartialChild(t *testing.T) {
	for _, scenario := range []string{"existing", "partial", "existing-before-preflight-failure"} {
		t.Run(scenario, func(t *testing.T) {
			effect, journal, priorID := knownNoImageCreateFixture(t)
			next := effect
			next.PreviousIntentID = priorID
			childID := imageInitialOutcome(next).IntentID
			file := filepath.Join(journal, childID+".intent.json")
			if scenario == "partial" {
				if err := os.WriteFile(file, []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if err := syncNew(file, next); err != nil {
				t.Fatal(err)
			}
			var restore func()
			out, err := RetryKnownNoImageEffect(effect, journal, func(stage string) {
				if scenario == "existing-before-preflight-failure" && stage == "retry-basis-verified" {
					restore = replaceImageParent(t, effect)
				}
			})
			if out.IntentID != childID || out.IntentID == priorID || err == nil {
				t.Fatalf("existing child hidden: %+v %v", out, err)
			}
			if scenario == "existing-before-preflight-failure" {
				if !errors.Is(err, errImageAncestor) {
					t.Fatal(err)
				}
				restore()
			} else if !errors.Is(err, os.ErrExist) {
				t.Fatal(err)
			}
			inspection, inspectErr := InspectImageEffect(next, journal)
			if scenario == "partial" {
				if inspectErr == nil {
					t.Fatal("partial intent verified")
				}
			} else if inspectErr != nil || inspection.RetryBasisAvailable || inspection.CompletionRecorded {
				t.Fatalf("invented child outcome: %+v %v", inspection, inspectErr)
			}
		})
	}
}

func TestImageRetryAfterPublicationFailureRetainsChild(t *testing.T) {
	effect, journal, priorID := knownNoImageCreateFixture(t)
	var restore func()
	out, err := RetryKnownNoImageEffect(effect, journal, func(stage string) {
		if stage == "intent-durable" {
			restore = replaceImageParent(t, effect)
		}
	})
	next := effect
	next.PreviousIntentID = priorID
	childID := imageInitialOutcome(next).IntentID
	if !errors.Is(err, errImageAncestor) || out.IntentID != childID || out.Status != "not-started" {
		t.Fatalf("durable child hidden: %+v %v", out, err)
	}
	restore()
	inspection, err := InspectImageEffect(next, journal)
	if err != nil || !inspection.NoWriteRecorded || !inspection.RetryBasisAvailable {
		t.Fatalf("lost child's own no-write evidence: %+v %v", inspection, err)
	}
}

func TestImageOwnerCrashNeverReplaysUnknown(t *testing.T) {
	for _, scenario := range []struct{ operation, stage, want string }{
		{"create", "before-first-effect", "preimage-observed"},
		{"create", "created-empty", "partial-or-concurrent"},
		{"create", "before-journal-ack", "postimage-observed"},
		{"delete", "delete-marked", "postimage-observed"},
		{"mode", "mode-updated", "postimage-observed"},
	} {
		t.Run(scenario.operation+"/"+scenario.stage, func(t *testing.T) {
			effect, journal := imageFixture(t)
			if scenario.operation == "create" {
				effect.Before = Image{Kind: "absent"}
				effect.Path = "created.txt"
			}
			if scenario.operation == "delete" {
				effect.After = Image{Kind: "absent"}
			}
			if scenario.operation == "mode" {
				effect.After = effect.Before
				effect.After.Mode = 0444
			}
			encoded, _ := json.Marshal(effect)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := imageCommand(ctx, "owner", "HEAD_IMAGE_EFFECT_INPUT="+string(encoded), "HEAD_IMAGE_EFFECT_JOURNAL="+journal, "HEAD_IMAGE_EFFECT_PHASE="+scenario.stage)
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			fmt.Printf("{\"event\":\"started-image-effect-test\",\"pid\":%d,\"parentPid\":%d,\"ports\":[]}\n", cmd.Process.Pid, os.Getpid())
			scanner := bufio.NewScanner(stdout)
			ready := scanner.Scan() && scanner.Text() == "phase:"+scenario.stage
			if ready {
				if err := os.Rename(journal, journal+"-lost"); err == nil {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
					t.Fatal("live native owner did not retain its journal directory fence")
				}
			}
			_ = cmd.Process.Signal(os.Interrupt)
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			fmt.Printf("{\"event\":\"exited-image-effect-test\",\"pid\":%d,\"ports\":[]}\n", cmd.Process.Pid)
			if !ready {
				t.Fatal("owner did not reach bounded crash phase")
			}
			inspection, err := InspectImageEffect(effect, journal)
			if err != nil || inspection.Status != scenario.want || !inspection.StartedRecorded || inspection.CompletionRecorded || inspection.NoWriteRecorded || inspection.RetryBasisAvailable {
				t.Fatalf("unknown effect: %+v %v", inspection, err)
			}
			if _, err := RetryKnownNoImageEffect(effect, journal, nil); !errors.Is(err, ErrConflict) {
				t.Fatalf("unknown retried: %v", err)
			}
			if _, err := ApplyImageEffect(effect, journal, nil); !errors.Is(err, os.ErrExist) {
				t.Fatalf("unknown initial replay: %v", err)
			}
			for name, data := range snapshotFiles(t, journal) {
				if strings.HasSuffix(name, ".intent.json") && !strings.Contains(data, `"before":`) {
					t.Fatal("preimage lost")
				}
			}
		})
	}
}
