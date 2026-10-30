//go:build windows

package fileeffect

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func fixture(t *testing.T) (Edit, string) {
	t.Helper()
	parent := t.TempDir()
	root, journal := filepath.Join(parent, "source"), filepath.Join(parent, "journal")
	for _, dir := range []string{root, journal} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "owned.txt"), []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	identity, err := ProbeRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	return Edit{Root: root, RootIdentity: identity, AncestorIdentities: []string{identity}, Path: "owned.txt", Before: []byte("before"), After: []byte("after-longer"), MaxBytes: 4096}, journal
}

func TestNestedAncestorReplacementAfterIntent(t *testing.T) {
	edit, journal := fixture(t)
	nested := filepath.Join(edit.Root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "owned.txt"), edit.Before, 0600); err != nil {
		t.Fatal(err)
	}
	edit.Path = "nested/owned.txt"
	identities, err := ProbeAncestorIdentities(edit.Root, edit.Path)
	if err != nil {
		t.Fatal(err)
	}
	edit.AncestorIdentities = identities
	out, err := EditExisting(edit, journal, func(phase string) {
		if phase != "intent-durable" {
			return
		}
		if err := os.Rename(nested, nested+"-retained"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(nested, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nested, "owned.txt"), edit.Before, 0600); err != nil {
			t.Fatal(err)
		}
	})
	if !errors.Is(err, ErrConflict) || out.Status != "not-started" {
		t.Fatalf("replacement accepted or uncertain no-write: %+v %v", out, err)
	}
	current, _ := os.ReadFile(filepath.Join(nested, "owned.txt"))
	if string(current) != "before" {
		t.Fatal("replacement changed")
	}
	if _, err := os.Stat(filepath.Join(journal, out.IntentID+".not-started.json")); err != nil {
		t.Fatal("no-write proof missing")
	}
}

func TestRootReplacementRefused(t *testing.T) {
	edit, journal := fixture(t)
	old := edit.Root + "-retained"
	if err := os.Rename(edit.Root, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(edit.Root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(edit.Root, edit.Path), edit.Before, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := EditExisting(edit, journal, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("root replacement accepted: %v", err)
	}
	current, _ := os.ReadFile(filepath.Join(edit.Root, edit.Path))
	if string(current) != "before" {
		t.Fatal("replacement changed")
	}
}

func TestExistingEditAndNoReplay(t *testing.T) {
	edit, journal := fixture(t)
	out, err := EditExisting(edit, journal, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "bytes-flushed" || out.MetadataCAS || out.MultiFileAtomic {
		t.Fatalf("bad outcome: %+v", out)
	}
	data, err := os.ReadFile(filepath.Join(edit.Root, edit.Path))
	if err != nil || string(data) != string(edit.After) {
		t.Fatalf("postimage: %s %v", data, err)
	}
	intent, err := os.ReadFile(filepath.Join(journal, out.IntentID+".intent.json"))
	if err != nil {
		t.Fatal(err)
	}
	var retained Edit
	if err := json.Unmarshal(intent, &retained); err != nil || string(retained.Before) != "before" {
		t.Fatalf("lost preimage: %v", err)
	}
	if _, err := EditExisting(edit, journal, nil); !errors.Is(err, os.ErrExist) {
		t.Fatalf("replay was not refused: %v", err)
	}
	inspection, err := InspectExisting(edit, journal)
	if err != nil || !inspection.CompletionRecorded || inspection.Status != "postimage-observed" || inspection.AppliedByThisRead {
		t.Fatalf("inspection: %+v %v", inspection, err)
	}
	if err := os.WriteFile(filepath.Join(edit.Root, edit.Path), []byte("user edit"), 0600); err != nil {
		t.Fatal(err)
	}
	inspection, err = InspectExisting(edit, journal)
	if err != nil || inspection.Status != "partial-or-concurrent" || !inspection.CompletionRecorded {
		t.Fatalf("lost current change: %+v %v", inspection, err)
	}
}

func TestPreimageConflictLeavesSource(t *testing.T) {
	edit, journal := fixture(t)
	edit.Before = []byte("wrong!")
	if _, err := EditExisting(edit, journal, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("wanted conflict, got %v", err)
	}
	data, _ := os.ReadFile(filepath.Join(edit.Root, edit.Path))
	if string(data) != "before" {
		t.Fatal("modified conflicting source")
	}
}

func TestKnownBusyNoWriteCanOfferFreshRetryBasis(t *testing.T) {
	edit, journal := fixture(t)
	p, err := syscall.UTF16PtrFromString(filepath.Join(edit.Root, edit.Path))
	if err != nil {
		t.Fatal(err)
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	out, effectErr := EditExisting(edit, journal, nil)
	syscall.CloseHandle(h)
	if !errors.Is(effectErr, syscall.Errno(32)) || out.Status != "not-started" {
		t.Fatalf("busy is not known no-write: %+v %v", out, effectErr)
	}
	inspection, err := InspectExisting(edit, journal)
	if err != nil || !inspection.NoWriteRecorded || inspection.StartedRecorded || !inspection.RetryBasisAvailable || inspection.Status != "preimage-observed" {
		t.Fatalf("retry basis: %+v %v", inspection, err)
	}
	// Availability is evidence for a new bounded attempt, not automatic execution.
	current, _ := os.ReadFile(filepath.Join(edit.Root, edit.Path))
	if string(current) != "before" {
		t.Fatal("inspection mutated file")
	}
	changed := edit
	changed.PreviousIntentID = out.IntentID
	changed.After = []byte("different")
	if _, err := EditExisting(changed, journal, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("divergent retry accepted: %v", err)
	}
	retry, err := RetryKnownNoWrite(edit, journal, nil)
	if err != nil || retry.Status != "bytes-flushed" || retry.IntentID == out.IntentID {
		t.Fatalf("known-no-write retry: %+v %v", retry, err)
	}
	if _, err := RetryKnownNoWrite(edit, journal, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("completed source was retried: %v", err)
	}
	if err := os.WriteFile(filepath.Join(journal, out.IntentID+".intent.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectExisting(edit, journal); !errors.Is(err, ErrConflict) {
		t.Fatalf("intent tamper accepted: %v", err)
	}
}

func TestEffectSubprocess(t *testing.T) {
	mode := os.Getenv("HEAD_FILE_EFFECT_TEST_MODE")
	if mode == "" {
		return
	}
	if mode == "writer" {
		file, err := os.OpenFile(os.Getenv("HEAD_FILE_EFFECT_TARGET"), os.O_WRONLY, 0)
		if err == nil {
			file.Close()
			os.Exit(7)
		}
		if !errors.Is(err, syscall.Errno(32)) {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(8)
		}
		fmt.Println("sharing-violation")
		os.Exit(0)
	}
	if mode == "owner" {
		var edit Edit
		if err := json.Unmarshal([]byte(os.Getenv("HEAD_FILE_EFFECT_EDIT")), &edit); err != nil {
			os.Exit(9)
		}
		_, err := EditExisting(edit, os.Getenv("HEAD_FILE_EFFECT_JOURNAL"), func(phase string) {
			if phase == os.Getenv("HEAD_FILE_EFFECT_PHASE") {
				fmt.Println("phase:" + phase)
				select {}
			}
		})
		fmt.Fprintln(os.Stderr, err)
		os.Exit(10)
	}
	os.Exit(11)
}

func ownedCommand(ctx context.Context, mode string, extra ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestEffectSubprocess$")
	cmd.Env = append(os.Environ(), append([]string{"HEAD_FILE_EFFECT_TEST_MODE=" + mode}, extra...)...)
	cwd, _ := os.Getwd()
	line, _ := json.Marshal(map[string]any{"event": "planned-file-effect-test", "command": cmd.Path, "args": cmd.Args, "cwd": cwd, "parentPid": os.Getpid(), "ports": []int{}})
	fmt.Println(string(line))
	return cmd
}

func TestSeparateWriterDeniedWhileLocked(t *testing.T) {
	edit, journal := fixture(t)
	_, err := EditExisting(edit, journal, func(phase string) {
		if phase != "locked-preimage" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := ownedCommand(ctx, "writer", "HEAD_FILE_EFFECT_TARGET="+filepath.Join(edit.Root, edit.Path))
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		fmt.Printf("{\"event\":\"started-file-effect-test\",\"pid\":%d,\"parentPid\":%d,\"ports\":[]}\n", cmd.Process.Pid, os.Getpid())
		err := cmd.Wait()
		fmt.Printf("{\"event\":\"exited-file-effect-test\",\"pid\":%d,\"ports\":[]}\n", cmd.Process.Pid)
		if err != nil {
			t.Fatalf("separate writer not denied: %v", err)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestOwnerCrashRetainsOriginalAndCurrentBytes(t *testing.T) {
	for _, stage := range []string{"before-first-write", "truncated", "before-journal-ack"} {
		t.Run(stage, func(t *testing.T) {
			edit, journal := fixture(t)
			encoded, _ := json.Marshal(edit)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := ownedCommand(ctx, "owner", "HEAD_FILE_EFFECT_EDIT="+string(encoded), "HEAD_FILE_EFFECT_JOURNAL="+journal, "HEAD_FILE_EFFECT_PHASE="+stage)
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			fmt.Printf("{\"event\":\"started-file-effect-test\",\"pid\":%d,\"parentPid\":%d,\"ports\":[]}\n", cmd.Process.Pid, os.Getpid())
			scanner := bufio.NewScanner(stdout)
			ready := scanner.Scan() && scanner.Text() == "phase:"+stage
			// Windows console-less children cannot receive os.Interrupt. Attempt it
			// first, then kill only this exact owned PID for the crash experiment.
			_ = cmd.Process.Signal(os.Interrupt)
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			fmt.Printf("{\"event\":\"exited-file-effect-test\",\"pid\":%d,\"ports\":[]}\n", cmd.Process.Pid)
			if !ready {
				t.Fatal("owner never reached requested crash phase")
			}
			files, err := os.ReadDir(journal)
			if err != nil {
				t.Fatal(err)
			}
			intents := 0
			for _, file := range files {
				if strings.HasSuffix(file.Name(), ".completed.json") {
					t.Fatal("unacknowledged effect was recorded as completed")
				}
				if strings.HasSuffix(file.Name(), ".intent.json") {
					intents++
					b, _ := os.ReadFile(filepath.Join(journal, file.Name()))
					var retained Edit
					if err := json.Unmarshal(b, &retained); err != nil || string(retained.Before) != "before" {
						t.Fatal("preimage lost")
					}
				}
			}
			if intents != 1 {
				t.Fatal("missing unique durable intent")
			}
			current, _ := os.ReadFile(filepath.Join(edit.Root, edit.Path))
			if stage == "truncated" && len(current) != 0 {
				t.Fatalf("wanted partial empty bytes, got %q", current)
			}
			if stage == "before-journal-ack" && string(current) != string(edit.After) {
				t.Fatalf("wanted flushed postimage, got %q", current)
			}
			if stage == "before-first-write" && string(current) != string(edit.Before) {
				t.Fatal("prewrite crash changed bytes")
			}
			if _, err := EditExisting(edit, journal, nil); !errors.Is(err, os.ErrExist) {
				t.Fatalf("crash was automatically replayed: %v", err)
			}
			inspection, err := InspectExisting(edit, journal)
			want := "partial-or-concurrent"
			if stage == "before-first-write" {
				want = "preimage-observed"
			}
			if stage == "before-journal-ack" {
				want = "postimage-observed"
			}
			if err != nil || !inspection.StartedRecorded || inspection.CompletionRecorded || inspection.Status != want || inspection.AppliedByThisRead || inspection.RetryBasisAvailable {
				t.Fatalf("crash inspection: %+v %v", inspection, err)
			}
			if _, err := RetryKnownNoWrite(edit, journal, nil); !errors.Is(err, ErrConflict) {
				t.Fatalf("unknown crash retry accepted: %v", err)
			}
		})
	}
}
