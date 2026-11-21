package processsupervisor

import (
	"errors"
	"os"
)

// Windows File.Close already cancels the pending pipe read.
func prepareInteractivePipe(source *os.File) (*os.File, error) {
	stat, err := source.Stat()
	if err != nil {
		return nil, err
	}
	if stat.Mode()&os.ModeNamedPipe == 0 {
		return nil, errors.New("not a pipe")
	}
	return source, nil
}
