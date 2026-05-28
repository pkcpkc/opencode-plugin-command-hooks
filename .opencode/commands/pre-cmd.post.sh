#!/bin/bash

echo "pre-cmd.post.sh executed in: $(pwd)"
echo $(pwd)

echo "Calling sub-folder nested script:"
bash subfolder/nested.sh
