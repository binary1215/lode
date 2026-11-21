package main

// This entrypoint exists only in `go test -c` binaries. Ordinary go build uses
// main.go unchanged: no environment switch, request field or runtime fault API.
import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/binary1215/lode/native/lode-agent-worker/internal/processsupervisor"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && strings.HasPrefix(os.Args[1], "-test.") {
		os.Exit(m.Run())
	}
	if len(os.Args) == 3 && os.Args[1] == "--job" {
		code, err := processsupervisor.RunJob(os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(code)
		}
		if code == 0 {
			directory := filepath.Dir(os.Args[2])
			// RunJob has synced/published terminal.json and quiesced its child
			// tree. The same native PID/claim still exists before os.Exit.
			marker, err := os.OpenFile(filepath.Join(directory, "terminal-held.test.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				panic(err)
			}
			err = json.NewEncoder(marker).Encode(map[string]any{"pid": os.Getpid(), "parentPid": os.Getppid(), "phase": "after-runjob-before-owner-exit", "ports": []int{}})
			if err == nil {
				err = marker.Sync()
			}
			closeErr := marker.Close()
			if err != nil || closeErr != nil {
				panic("cannot publish test boundary")
			}
			// A test can release normally for cleanup. A finite fallback prevents
			// a broken test parent leaving an indefinitely held native owner.
			deadline := time.Now().Add(30 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := os.Stat(filepath.Join(directory, "terminal-release.test")); err == nil {
					os.Exit(code)
				}
				time.Sleep(10 * time.Millisecond)
			}
			os.Exit(98)
		}
		os.Exit(code)
	}
	// All other native operations execute the production command entrypoint.
	main()
	os.Exit(0)
}
