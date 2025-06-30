import os
import sys
from pyicloud import PyiCloudService # type: ignore
from pyicloud.services.drive import DriveNode   # type: ignore

api = PyiCloudService('djdunford@gmail.com')
folder = "photo_library_20240521"

def upload_file(path: str, filename: str, icloud_directory: DriveNode):
    full_filename = os.path.join(path, filename)
    print("Opening ", full_filename)
    with open(full_filename, 'rb') as file:
        print("Opened")
        icloud_directory.upload(file) # type: ignore

if api.requires_2fa:
    print("Two-factor authentication required.")
    code = input("Enter the code you received of one of your approved devices: ")
    result = api.validate_2fa_code(code)
    print("Code validation result: %s" % result)

    if not result:
        print("Failed to verify security code")
        sys.exit(1)

    if not api.is_trusted_session:
        print("Session is not trusted. Requesting trust...")
        result = api.trust_session()
        print("Session trust result %s" % result)

        if not result:
            print("Failed to request trust. You will likely be prompted for the code again in the coming weeks")

print("SUCCESS!")
directory=api.drive[folder]
try:
    upload_file("/media/darren/3A686BC5686B7F0F/Users/djdun/Pictures/000 Miscellaneous", "27072007.jpg", directory)
    print("UPLOADED")
except Exception as e:
    print("FAILED", e)

